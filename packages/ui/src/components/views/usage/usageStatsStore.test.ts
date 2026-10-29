import { describe, expect, test } from 'bun:test';

import type { UsageStats, UsageTools } from '@/lib/opencode/session-stats';

import {
  USAGE_STATS_FRESH_MS,
  createUsageStatsStore,
  usageStatsKey,
  type UsageStatsRequest,
  type UsageStatsStorage,
} from './usageStatsStore';

const toolCalls = (calls: number): UsageTools => ({ mode: 'detail', totals: { calls, succeeded: calls, failed: 0, unfinished: 0 }, usage: [] });

const report = (prompts: number): UsageStats => ({
  range: { from: 0, to: 1 },
  sessions: 1,
  subagents: 0,
  prompts,
  steps: prompts,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  tools: { mode: 'none' },
  activeDays: 1,
  streak: 1,
  activity: [],
  models: [],
});

type Pending = {
  request: UsageStatsRequest;
  signal: AbortSignal;
  resolve: (stats: UsageStats) => void;
  reject: (error: Error) => void;
};

type PendingTools = {
  request: UsageStatsRequest;
  window: UsageStats['range'];
  signal: AbortSignal;
  resolve: (tools: UsageTools) => void;
  reject: (error: Error) => void;
};

type MemoryStorage = UsageStatsStorage & { values: Map<string, string> };

const createMemoryStorage = (): MemoryStorage => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
};

function setup(options: { storage?: UsageStatsStorage | null } = {}) {
  const pending: Pending[] = [];
  const pendingTools: PendingTools[] = [];
  let runtime = 'runtime-a';
  let clock = 1000;
  const store = createUsageStatsStore(
    (request, signal) => new Promise<UsageStats>((resolve, reject) => {
      pending.push({ request, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    () => runtime,
    () => clock,
    (request, window, signal) => new Promise<UsageTools>((resolve, reject) => {
      pendingTools.push({ request, window, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    options.storage ?? null,
  );
  return {
    store,
    pending,
    pendingTools,
    setRuntime: (next: string) => {
      runtime = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const A: UsageStatsRequest = { range: '7d', projectDirectory: null };
const B: UsageStatsRequest = { range: '30d', projectDirectory: '/code/app' };
const C: UsageStatsRequest = { range: '90d', projectDirectory: '/code/other' };
const entry = (ctx: ReturnType<typeof setup>, request: UsageStatsRequest, runtime = 'runtime-a') =>
  ctx.store.getState().entries[usageStatsKey(runtime, request)];

const loadAndResolve = async (ctx: ReturnType<typeof setup>, request: UsageStatsRequest, stats: UsageStats) => {
  const read = ctx.store.getState().load(request);
  ctx.pending.at(-1)!.resolve(stats);
  await read;
};

describe('usage stats cache', () => {
  test('keys by runtime, range and project', () => {
    expect(usageStatsKey('r', A)).not.toBe(usageStatsKey('r', { ...A, range: '30d' }));
    expect(usageStatsKey('r', A)).not.toBe(usageStatsKey('r', { ...A, projectDirectory: '/x' }));
    expect(usageStatsKey('r', A)).not.toBe(usageStatsKey('s', A));
  });

  test('fetches a key once and serves it from cache until forced', async () => {
    const ctx = setup();
    const first = ctx.store.getState().load(A);
    ctx.pending[0].resolve(report(3));
    await first;
    expect(entry(ctx, A)).toEqual({ stats: report(3), fetchedAt: 1000, loading: false, error: null });

    await ctx.store.getState().load(A);
    expect(ctx.pending).toHaveLength(1);

    void ctx.store.getState().load(A, { force: true });
    expect(ctx.pending).toHaveLength(2);
    expect(entry(ctx, A)?.stats).toEqual(report(3));
    expect(entry(ctx, A)?.loading).toBe(true);
  });

  test('a failed refresh keeps the cached report', async () => {
    const ctx = setup();
    const first = ctx.store.getState().load(A);
    ctx.pending[0].resolve(report(3));
    await first;
    const refresh = ctx.store.getState().load(A, { force: true });
    ctx.pending[1].reject(new Error('offline'));
    await refresh;
    expect(entry(ctx, A)).toEqual({ stats: report(3), fetchedAt: 1000, loading: false, error: 'offline' });
  });

  test('a superseded range read is aborted and clears its loading state', async () => {
    const ctx = setup();
    const a = ctx.store.getState().load(A);
    const b = ctx.store.getState().load(B);
    expect(ctx.pending[0].signal.aborted).toBe(true);

    ctx.pending[1].resolve(report(2));
    await b;
    await a;
    expect(entry(ctx, A)).toEqual({ stats: null, fetchedAt: null, loading: false, error: null });
    expect(entry(ctx, B)?.stats).toEqual(report(2));
  });

  test('switching to a cached range aborts the scan it replaces', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, B, report(2));

    const a = ctx.store.getState().load(A);
    expect(ctx.pending).toHaveLength(2);
    await ctx.store.getState().load(B);

    expect(ctx.pending[1].signal.aborted).toBe(true);
    await a;
    expect(entry(ctx, A)?.loading).toBe(false);
    expect(entry(ctx, B)?.stats).toEqual(report(2));
  });

  test('a runtime switch clears the cache and drops reads in flight', async () => {
    const ctx = setup();
    const a = ctx.store.getState().load(A);
    ctx.setRuntime('runtime-b');
    ctx.store.getState().reset();
    ctx.pending[0].resolve(report(9));
    await a;
    expect(ctx.store.getState().entries).toEqual({});
  });
});

describe('persisted reports', () => {
  test('hydrates a persisted report and serves it without a read', async () => {
    const storage = createMemoryStorage();
    const first = setup({ storage });
    await loadAndResolve(first, A, report(3));
    expect(storage.values.size).toBe(1);

    const second = setup({ storage });
    expect(entry(second, A)).toEqual({ stats: report(3), fetchedAt: 1000, loading: false, error: null });

    await second.store.getState().load(A);
    expect(second.pending).toHaveLength(0);
  });

  test('a stale persisted report refreshes in the background', async () => {
    const storage = createMemoryStorage();
    const first = setup({ storage });
    await loadAndResolve(first, A, report(3));

    const second = setup({ storage });
    second.advance(USAGE_STATS_FRESH_MS);
    const refresh = second.store.getState().load(A);
    expect(entry(second, A)?.stats).toEqual(report(3));
    expect(entry(second, A)?.loading).toBe(true);
    expect(second.pending).toHaveLength(1);

    second.pending[0].resolve(report(4));
    await refresh;
    expect(entry(second, A)).toEqual({
      stats: report(4),
      fetchedAt: 1000 + USAGE_STATS_FRESH_MS,
      loading: false,
      error: null,
    });
  });

  test('a failed background refresh keeps the persisted report', async () => {
    const storage = createMemoryStorage();
    const first = setup({ storage });
    await loadAndResolve(first, A, report(3));

    const second = setup({ storage });
    second.advance(USAGE_STATS_FRESH_MS);
    const refresh = second.store.getState().load(A);
    second.pending[0].reject(new Error('offline'));
    await refresh;
    expect(entry(second, A)).toEqual({
      stats: report(3),
      fetchedAt: 1000,
      loading: false,
      error: 'offline',
    });
  });

  test('a report stamped ahead of the clock refreshes instead of staying fresh', async () => {
    const storage = createMemoryStorage();
    const first = setup({ storage });
    await loadAndResolve(first, A, report(3));

    const second = setup({ storage });
    second.advance(-500);
    const refresh = second.store.getState().load(A);
    expect(entry(second, A)?.stats).toEqual(report(3));
    expect(second.pending).toHaveLength(1);

    second.pending[0].resolve(report(4));
    await refresh;
    expect(entry(second, A)?.stats).toEqual(report(4));
  });

  test('keeps reports another window wrote for this runtime', async () => {
    const storage = createMemoryStorage();
    const windowOne = setup({ storage });
    await loadAndResolve(windowOne, A, report(1));

    const windowTwo = setup({ storage });
    await loadAndResolve(windowOne, B, report(2));
    await loadAndResolve(windowTwo, C, report(3));

    const reopened = setup({ storage });
    expect(entry(reopened, A)?.stats).toEqual(report(1));
    expect(entry(reopened, B)?.stats).toEqual(report(2));
    expect(entry(reopened, C)?.stats).toEqual(report(3));
  });

  test("a runtime switch hydrates only that runtime's persisted reports", async () => {
    const storage = createMemoryStorage();
    const ctx = setup({ storage });
    await loadAndResolve(ctx, A, report(3));

    ctx.setRuntime('runtime-b');
    ctx.store.getState().reset();
    expect(ctx.store.getState().entries).toEqual({});

    await loadAndResolve(ctx, B, report(7));
    expect(entry(ctx, B, 'runtime-b')?.stats).toEqual(report(7));

    ctx.setRuntime('runtime-a');
    ctx.store.getState().reset();
    expect(entry(ctx, A, 'runtime-a')?.stats).toEqual(report(3));
    expect(entry(ctx, B, 'runtime-a')).toBeUndefined();
  });

  test('ignores a corrupt or foreign persisted payload', async () => {
    const corrupt = createMemoryStorage();
    corrupt.setItem('openchamber.usage-stats.v1', '{not json');
    expect(setup({ storage: corrupt }).store.getState().entries).toEqual({});

    const invalid = createMemoryStorage();
    invalid.setItem('openchamber.usage-stats.v1', JSON.stringify({
      version: 1,
      entries: [{ key: 'runtime-a::7d::__all__', stats: { range: {} }, fetchedAt: 1 }],
    }));
    expect(setup({ storage: invalid }).store.getState().entries).toEqual({});
  });
});

describe('tool calls on request', () => {
  const tools = (ctx: ReturnType<typeof setup>, request: UsageStatsRequest) =>
    ctx.store.getState().toolEntries[usageStatsKey('runtime-a', request)];

  test('the report alone never asks for tool calls', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, A, report(3));
    expect(ctx.pendingTools).toHaveLength(0);
  });

  test('counts tool calls over the window of the report on screen', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, A, { ...report(3), range: { from: 100, to: 200 } });
    const read = ctx.store.getState().loadTools(A);
    expect(ctx.pendingTools[0].window).toEqual({ from: 100, to: 200 });
    ctx.pendingTools[0].resolve(toolCalls(7));
    await read;
    expect(tools(ctx, A)).toEqual({ tools: toolCalls(7), loading: false, error: null });
  });

  test('a failed read keeps the report and never becomes zero calls', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, A, report(3));
    const read = ctx.store.getState().loadTools(A);
    ctx.pendingTools[0].reject(new Error('scan failed'));
    await read;
    expect(tools(ctx, A)).toEqual({ tools: null, loading: false, error: 'scan failed' });
    expect(entry(ctx, A)?.stats).toEqual(report(3));
    expect(entry(ctx, A)?.error).toBeNull();
  });

  test('once asked for, a refreshed report brings fresh tool calls for its new window', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, A, report(3));
    const first = ctx.store.getState().loadTools(A);
    ctx.pendingTools[0].resolve(toolCalls(1));
    await first;

    const refresh = ctx.store.getState().load(A, { force: true });
    ctx.pending[1].resolve({ ...report(4), range: { from: 300, to: 400 } });
    await refresh;
    expect(ctx.pendingTools).toHaveLength(2);
    expect(ctx.pendingTools[1].window).toEqual({ from: 300, to: 400 });
  });

  test('changing the range does not abort a tool read in flight', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, A, report(3));
    const read = ctx.store.getState().loadTools(A);
    const next = ctx.store.getState().load(B);
    expect(ctx.pendingTools[0].signal.aborted).toBe(false);

    ctx.pendingTools[0].resolve(toolCalls(5));
    await read;
    expect(tools(ctx, A)?.tools).toEqual(toolCalls(5));

    ctx.pending[1].resolve(report(2));
    await next;
  });

  test('drops counts that land after their report window was replaced', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, A, { ...report(3), range: { from: 100, to: 200 } });
    const stale = ctx.store.getState().loadTools(A);
    expect(ctx.pendingTools[0].window).toEqual({ from: 100, to: 200 });

    const refresh = ctx.store.getState().load(A, { force: true });
    ctx.pending[1].resolve({ ...report(4), range: { from: 300, to: 400 } });
    await refresh;
    // The refresh wants tools too, but the read for the old window is still
    // running, so it does not start a second one.
    expect(ctx.pendingTools).toHaveLength(1);

    ctx.pendingTools[0].resolve(toolCalls(7));
    await stale;
    // The old window's counts were dropped, not shown under the new report.
    expect(tools(ctx, A)?.tools).toBeNull();
    expect(ctx.pendingTools).toHaveLength(2);
    expect(ctx.pendingTools[1].window).toEqual({ from: 300, to: 400 });

    ctx.pendingTools[1].resolve(toolCalls(9));
    await Promise.resolve();
    await Promise.resolve();
    expect(tools(ctx, A)).toEqual({ tools: toolCalls(9), loading: false, error: null });
  });

  test('a runtime switch drops tool reads in flight', async () => {
    const ctx = setup();
    await loadAndResolve(ctx, A, report(3));
    const read = ctx.store.getState().loadTools(A);
    ctx.store.getState().reset();
    ctx.pendingTools[0].resolve(toolCalls(5));
    await read;
    expect(ctx.store.getState().toolEntries).toEqual({});
  });
});
