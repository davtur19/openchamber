// Selective cloud proxy for server-side direct LLM calls.
//
// OpenCode's own serve process routes its cloud-model traffic through
// OPENCODE_CLOUD_PROXY (see the FetchProxy util in the opencode repo: only
// opencode-cloud hostnames go through it, everything else uses the direct
// path). This module mirrors that rule for the small-model calls OpenChamber
// makes itself — goal audits, session assist, walkthroughs — which otherwise
// leave the server with the datacenter IP while chat turns leave through the
// proxy, splitting one logical quota across two source addresses.
//
// No dependency: Node 20 has no built-in proxy support for fetch, so HTTPS
// targets are reached with a manual CONNECT tunnel + TLS over the tunnelled
// socket, and plain-HTTP targets with an absolute-form request line. Only
// hostnames in CLOUD_PROXY_DOMAINS (overridable via
// OPENCODE_CLOUD_PROXY_DOMAINS, comma-separated, `*.` wildcards allowed) are
// tunnelled; every other host keeps using the global fetch untouched, so
// provider APIs, loopback, and user-configured gateways never change path.

const CONNECT_TIMEOUT_MS = 10_000;
// No data received for this long after the last byte: the upstream stalled
// mid-response. Generous on purpose — the caller's own signal already carries
// the per-request deadline (call.js requestSignal), so this only guards a
// socket that goes quiet without ever closing.
const RESPONSE_IDLE_TIMEOUT_MS = 60_000;

import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_CLOUD_PROXY_DOMAINS = [
  'opencode.ai',
  'www.opencode.ai',
  'models.opencode.ai',
  'zenmux.ai',
  'gateway.opencode.ai',
  'api.opencode.ai',
  'app.opencode.ai',
  'console.opencode.ai',
  'dev.opencode.ai',
];

const proxyUrlOf = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const resolveCloudProxyUrl = () => {
  const proxy = proxyUrlOf(process.env.OPENCODE_CLOUD_PROXY);
  return proxy ? proxy.toString().replace(/\/+$/, '') : null;
};

const configuredDomains = () => {
  const raw = process.env.OPENCODE_CLOUD_PROXY_DOMAINS;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_CLOUD_PROXY_DOMAINS;
  const domains = raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return domains.length ? domains : DEFAULT_CLOUD_PROXY_DOMAINS;
};

const matchesDomain = (hostname, domain) => {
  if (domain.startsWith('*.')) {
    const suffix = domain.slice(1).toLowerCase();
    return hostname === domain.slice(2).toLowerCase() || hostname.endsWith(suffix);
  }
  return hostname === domain.toLowerCase();
};

/** True when the URL's host must leave through the cloud proxy. */
export const isCloudProxyHostname = (input) => {
  if (!resolveCloudProxyUrl()) return false;
  let hostname = '';
  try {
    hostname = typeof input === 'string' ? new URL(input).hostname.toLowerCase()
      : input instanceof URL ? input.hostname.toLowerCase()
      : new URL(input.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;
  return configuredDomains().some((domain) => matchesDomain(hostname, domain));
};

const readBodyBytes = async (body) => {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  // fetch also accepts FormData / URLSearchParams / Blob — none of the
  // small-model callers send those, so refuse loudly rather than silently
  // dropping the body through the tunnel.
  throw new Error('cloud proxy: unsupported request body type');
};

const headerEntries = (headers) => {
  const entries = [];
  if (!headers) return entries;
  if (typeof headers.forEach === 'function' && typeof headers.entries !== 'function') {
    // node-fetch style Headers — forEach exists on both, entries only on
    // undici; this branch keeps plain-object handling below for the rest.
    headers.forEach((value, name) => entries.push([name, value]));
    return entries;
  }
  if (typeof headers.entries === 'function') {
    for (const [name, value] of headers.entries()) entries.push([name, value]);
    return entries;
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) entries.push([String(name), String(value)]);
    return entries;
  }
  for (const [name, value] of Object.entries(headers)) entries.push([name, String(value)]);
  return entries;
};

const makeProxiedResponse = ({ status, headers, body }) => {
  const headerMap = new Map();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key === 'set-cookie') continue;
    if (headerMap.has(key)) headerMap.set(key, `${headerMap.get(key)}, ${value}`);
    else headerMap.set(key, value);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
    },
    json: async () => JSON.parse(body.toString('utf8')),
    text: async () => body.toString('utf8'),
  };
};

const connectTunnel = (proxy, targetHost, targetPort, signal) => new Promise((resolve, reject) => {
  let settled = false;
  const done = (value, isError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (isError) socket.destroy();
    (isError ? reject : resolve)(value);
  };
  const onAbort = () => done(signal.reason ?? new Error('cloud proxy: aborted'), true);
  // The proxy URL carries no credentials in our setup, but refuse to leak
  // them in cleartext on the CONNECT line if one is ever configured.
  const requestTarget = `${targetHost}:${targetPort}`;
  let socket;
  try {
    socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) });
  } catch (error) {
    reject(error);
    return;
  }
  const timer = setTimeout(() => done(new Error('cloud proxy: CONNECT timed out'), true), CONNECT_TIMEOUT_MS);
  if (signal?.aborted) {
    done(signal.reason ?? new Error('cloud proxy: aborted'), true);
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.once('error', (error) => done(error, true));
  let head = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    const statusLine = head.subarray(0, head.indexOf('\r\n')).toString();
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
    if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) {
      done(new Error(`cloud proxy: CONNECT to ${requestTarget} rejected (${statusLine || 'no status'})`), true);
      return;
    }
    const leftover = head.subarray(end + 4);
    socket.removeAllListeners('data');
    done({ socket, leftover });
  });
  socket.on('connect', () => {
    socket.write(`CONNECT ${requestTarget} HTTP/1.1\r\nHost: ${requestTarget}\r\n\r\n`);
  });
});

const fetchViaProxy = (proxy, url, init = {}) => new Promise((resolve, reject) => {
  let settled = false;
  const signal = init.signal ?? null;
  // Declared up front: done() runs on every exit path, including aborts that
  // fire before the async body registers its own listener.
  const onAbort = () => done(signal?.reason ?? new Error('cloud proxy: aborted'), true);
  const done = (value, isError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    (isError ? reject : resolve)(value);
  };
  // Absolute backstop for the whole tunneled request. Normally the caller's
  // own signal (call.js requestSignal) or the idle watchdog fires first; this
  // only catches a socket that stays alive without either condition tripping.
  const timer = setTimeout(() => done(new Error('cloud proxy: request timed out'), true), CONNECT_TIMEOUT_MS + RESPONSE_IDLE_TIMEOUT_MS);
  if (signal?.aborted) {
    done(signal.reason ?? new Error('cloud proxy: aborted'), true);
    return;
  }
  (async () => {
    const parsed = new URL(url);
    const isTls = parsed.protocol === 'https:';
    const targetPort = Number(parsed.port || (isTls ? 443 : 80));
    const method = init.method || 'GET';
    const bodyBytes = await readBodyBytes(init.body);
    const entries = headerEntries(init.headers);
    const hasHost = entries.some(([name]) => name.toLowerCase() === 'host');
    const hasLength = entries.some(([name]) => name.toLowerCase() === 'content-length');
    const hasConnection = entries.some(([name]) => name.toLowerCase() === 'connection');
    const lines = [`${method} ${parsed.pathname || '/'}${parsed.search || ''} HTTP/1.1`];
    if (!hasHost) lines.push(`Host: ${parsed.host}`);
    for (const [name, value] of entries) lines.push(`${name}: ${value}`);
    if (bodyBytes && !hasLength) lines.push(`Content-Length: ${bodyBytes.length}`);
    if (!hasConnection) lines.push('Connection: close');

    // fetch's signal doubles as our deadline: the callers already arm a
    // per-request timeout on it (requestSignal), so the socket must die with
    // it rather than outliving the caller up to CONNECT_TIMEOUT_MS.
    signal?.addEventListener('abort', onAbort, { once: true });
    const onSocket = (socket, preface = null) => {
      socket.once('error', (error) => finish(error, true));
      const chunks = [];
      // Idle watchdog: the overall deadline is a sliding window refreshed by
      // every received byte. The caller's own signal already carries the
      // absolute per-request deadline (call.js requestSignal), so this timer
      // only fires when the socket goes quiet mid-response — a stall the
      // caller's signal cannot see because its own clock only runs to 60s
      // from the call start while a thinking model can legitimately take
      // most of that before the first body byte.
      const idle = setTimeout(() => {
        finish(new Error('cloud proxy: response stalled'), true);
      }, RESPONSE_IDLE_TIMEOUT_MS);
      idle.unref?.();
      const finish = (value, isError) => {
        clearTimeout(idle);
        done(value, isError);
      };
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        idle.refresh();
      });
      socket.on('end', () => {
        const raw = Buffer.concat(chunks);
        const end = raw.indexOf('\r\n\r\n');
        if (end < 0) {
          finish(new Error('cloud proxy: malformed response'), true);
          return;
        }
        const headLines = raw.subarray(0, end).toString().split('\r\n');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headLines[0] || '')?.[1]);
        if (!Number.isFinite(status)) {
          finish(new Error('cloud proxy: malformed response status'), true);
          return;
        }
        const headers = [];
        for (const line of headLines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
        }
        finish(makeProxiedResponse({ status, headers, body: raw.subarray(end + 4) }));
      });
      const payload = Buffer.concat([
        Buffer.from(`${lines.join('\r\n')}\r\n\r\n`),
        bodyBytes || Buffer.alloc(0),
      ]);
      if (preface && preface.length) socket.write(Buffer.concat([preface, payload]));
      else socket.write(payload);
    };

    if (!isTls) {
      const socket = net.connect({ host: parsed.hostname, port: targetPort });
      // Plain HTTP goes straight to the target: the proxy is only needed to
      // change the egress address, and none of the cloud endpoints is HTTP.
      socket.once('error', (error) => done(error, true));
      socket.once('connect', () => onSocket(socket));
      return;
    }
    const { socket, leftover } = await connectTunnel(proxy, parsed.hostname, targetPort, signal);
    const secure = tls.connect({ socket, servername: parsed.hostname });
    // The tunnel socket belongs to the TLS session now: a late abort must
    // kill the secure socket, not the (already destroyed) tunnel.
    signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', () => secure.destroy(signal.reason ?? new Error('cloud proxy: aborted')), { once: true });
    secure.once('error', (error) => done(error, true));
    secure.once('secureConnect', () => onSocket(secure, leftover.length ? leftover : null));
  })().catch((error) => done(error, true));
});

/**
 * fetch() that routes opencode-cloud hostnames through OPENCODE_CLOUD_PROXY
 * and leaves every other URL on the global fetch. Drop-in for the direct
 * provider calls in this module.
 */
export const proxyFetch = (url, init) => {
  if (!isCloudProxyHostname(url)) return fetch(url, init);
  const proxy = proxyUrlOf(process.env.OPENCODE_CLOUD_PROXY);
  if (!proxy) return fetch(url, init);
  return fetchViaProxy(proxy, String(url), init);
};
