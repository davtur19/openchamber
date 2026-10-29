import http from 'node:http';

import express from 'express';
import { describe, expect, it } from 'vitest';

import { registerOpenCodeProxy } from './proxy.js';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  const listener = server.listen(0, '127.0.0.1', () => resolve(listener));
});

const close = (server) => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A real proxy in front of an upstream that accepts the connection and never
 * answers, with both deadlines short enough to observe.
 */
const withProxy = async ({ genericTimeoutMs, statsTimeoutMs }, run) => {
  const upstreamServer = await listen(http.createServer(() => {}));
  const upstreamPort = upstreamServer.address().port;

  const app = express();
  registerOpenCodeProxy(app, {
    fs: {},
    os: {},
    path: {},
    OPEN_CODE_READY_GRACE_MS: 0,
    LONG_REQUEST_TIMEOUT_MS: genericTimeoutMs,
    STATS_REQUEST_TIMEOUT_MS: statsTimeoutMs,
    getRuntime: () => ({
      openCodePort: upstreamPort,
      openCodeBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
    ensureOpenCodeApiPrefix: (pathname) => pathname,
  });
  const proxyServer = await listen(app);

  try {
    await run(`http://127.0.0.1:${proxyServer.address().port}`);
  } finally {
    await close(proxyServer);
    upstreamServer.closeAllConnections?.();
    await close(upstreamServer);
  }
};

describe('Stats route deadline', () => {
  it('keeps the stats read open past the generic proxy deadline', async () => {
    await withProxy({ genericTimeoutMs: 50, statsTimeoutMs: 600 }, async (base) => {
      const started = Date.now();
      const pending = fetch(`${base}/api/experimental/session/stats?tools=none`);
      const early = await Promise.race([
        pending.then((response) => `response:${response.status}`),
        delay(200).then(() => 'pending'),
      ]);

      // The generic 50 ms cut must not reach this route.
      expect(early).toBe('pending');

      const response = await pending;
      expect(response.status).toBe(504);
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    });
  }, 10_000);

  it('keeps the generic deadline for other routes', async () => {
    await withProxy({ genericTimeoutMs: 100, statsTimeoutMs: 5_000 }, async (base) => {
      const started = Date.now();
      const response = await fetch(`${base}/api/agent`);

      expect(response.status).toBe(504);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  }, 10_000);
});
