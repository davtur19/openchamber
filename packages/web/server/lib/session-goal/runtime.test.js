import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 1,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { openchamber: { goal } },
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(typeof input === 'string' ? input : input.url).pathname;

const startIdleTick = async (fetchImpl) => {
  const getSmallModelService = vi.fn();
  vi.stubGlobal('fetch', fetchImpl);
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    idleQuietMs: 10,
  });
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.advanceTimersByTimeAsync(10);
  return { runtime, getSmallModelService };
};

describe('session goal live activity gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the next parent idle when the parent resumed during the quiet window', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(2);
    runtime.stop();
  });

  it('waits for the parent result cycle while a direct child is working', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [CHILD_ID]: { type: 'busy' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([{ id: CHILD_ID, parentID: SESSION_ID }]);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
    ]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(3);
    runtime.stop();
  });

  it('retries the quiet window when live status cannot be read', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ error: 'unavailable' }, 503);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}`,
      '/session/status',
    ]);
    runtime.stop();
  });

  it('audits normally when the idle parent has no working children', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([{
          info: {
            id: 'msg_assistant',
            sessionID: SESSION_ID,
            role: 'assistant',
            providerID: 'provider',
            modelID: 'model',
            time: { completed: 2 },
            tokens: { input: 1, output: 1, cache: { read: 0 } },
          },
          parts: [{ type: 'text', text: 'The task is verified complete.' }],
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Task verified complete"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    const patch = requests.find((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
    expect(patch).toBeDefined();
    const writtenGoal = JSON.parse(patch.body).metadata.openchamber.goal;
    expect(writtenGoal).toMatchObject({
      status: 'complete',
      evaluationProviderID: 'provider',
      evaluationModelID: 'model',
    });
    runtime.stop();
  });
});

describe('session goal transient vs permanent failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const continueVerdict = {
    text: '{"verdict":"continue","note":"Still working"}',
    providerID: 'provider',
    modelID: 'model',
  };

  const assistantMessage = (overrides = {}) => ({
    info: {
      id: 'msg_assistant',
      sessionID: SESSION_ID,
      role: 'assistant',
      providerID: 'provider',
      modelID: 'model',
      time: { completed: 2 },
      tokens: { input: 1, output: 1, cache: { read: 0 } },
      ...overrides,
    },
    parts: [{ type: 'text', text: 'Still working on it.' }],
  });

  // Stateful harness: a PATCH write folds into the goal returned by the next
  // session GET, so streaks round-trip across ticks exactly like production
  // (the tick re-reads the persisted metadata on every cycle). A continuation
  // re-arms the loop the way the production busy→idle transition does.
  const startGoalHarness = async ({ messagesForFetch, generateSmallModelText }) => {
    let storedGoal = { ...goal };
    const patches = [];
    let messageFetches = 0;
    let runtime;
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
        const body = JSON.parse(init.body);
        storedGoal = body.metadata.openchamber.goal;
        patches.push(storedGoal);
        return jsonResponse({ id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: storedGoal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) {
        return jsonResponse({ id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: storedGoal } } });
      }
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        messageFetches += 1;
        return jsonResponse(messagesForFetch(messageFetches));
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        // Continuation makes the session busy; its idle transition re-arms.
        runtime.processPayload({
          type: 'session.status',
          properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
        });
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const service = { generateSmallModelText: vi.fn(generateSmallModelText) };
    runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    return { runtime, service, patches };
  };

  const lastPatch = (patches) => patches[patches.length - 1];

  it('blocks immediately on a permanent turn error', async () => {
    const { runtime, service, patches } = await startGoalHarness({
      messagesForFetch: () => [assistantMessage({
        error: { name: 'ProviderAuthError', data: { providerID: 'provider', message: 'no auth' } },
      })],
      generateSmallModelText: async () => continueVerdict,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(lastPatch(patches)).toMatchObject({ status: 'blocked', statusReason: 'ProviderAuthError' });
    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('retries a transient turn error (503) and resets the streak once the turn succeeds', async () => {
    const { runtime, service, patches } = await startGoalHarness({
      messagesForFetch: (n) => (n === 1
        ? [assistantMessage({ error: { name: 'APIError', data: { statusCode: 503, message: 'Service Unavailable', isRetryable: true } } })]
        : [assistantMessage()]),
      generateSmallModelText: async () => continueVerdict,
    });

    // First tick: transient 503 → goal stays active, streak persisted, timer re-armed.
    await vi.advanceTimersByTimeAsync(10);
    expect(lastPatch(patches)).toMatchObject({ status: 'active', turnErrorStreak: 1 });
    expect(patches.some((patch) => patch.status === 'blocked')).toBe(false);

    // Second tick: turn succeeds → streak cleared, audit ran, continuation sent.
    await vi.advanceTimersByTimeAsync(10);
    expect(lastPatch(patches)).toMatchObject({ status: 'active', turnErrorStreak: 0 });
    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    expect(patches.some((patch) => patch.status === 'blocked')).toBe(false);
    runtime.stop();
  });

  it('blocks a goal whose transient turn errors exhaust the retry limit', async () => {
    const { runtime, service, patches } = await startGoalHarness({
      messagesForFetch: () => [assistantMessage({
        error: { name: 'APIError', data: { statusCode: 502, message: 'Bad Gateway', isRetryable: true } },
      })],
      generateSmallModelText: async () => continueVerdict,
    });

    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(10);
    }
    const settled = patches.find((patch) => patch.status === 'blocked');
    expect(settled).toBeDefined();
    expect(settled.statusReason).toContain('transient provider error persisted');
    expect(service.generateSmallModelText).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('does not consume auditFailStreak on transient audit failures (5xx/429)', async () => {
    const { runtime, patches } = await startGoalHarness({
      messagesForFetch: () => [assistantMessage()],
      generateSmallModelText: async () => {
        throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      },
    });

    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(patches.some((patch) => patch.status === 'blocked')).toBe(false);
    for (const patch of patches) {
      expect(patch.auditFailStreak).toBe(0);
    }
    runtime.stop();
  });

  it('blocks the goal after two consecutive permanent audit failures', async () => {
    const { runtime, patches } = await startGoalHarness({
      messagesForFetch: () => [assistantMessage()],
      generateSmallModelText: async () => {
        throw Object.assign(new Error('No small model available'), { statusCode: 404 });
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(lastPatch(patches)).toMatchObject({ status: 'active', auditFailStreak: 1 });

    await vi.advanceTimersByTimeAsync(10);
    expect(lastPatch(patches)).toMatchObject({ status: 'blocked', statusReason: 'progress audit unavailable' });
    runtime.stop();
  });
});
