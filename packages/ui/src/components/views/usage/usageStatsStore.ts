import { create } from 'zustand';
import { z } from 'zod';

import { fetchUsageStats, fetchUsageTools, resolveUsageProjectID, type UsageStats, type UsageTools } from '@/lib/opencode/session-stats';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getSafeStorage } from '@/stores/utils/safeStorage';

import { rangeStart, type UsageRange } from './usageStatsModel';

/**
 * Stats page reports, cached per (runtime, range, project).
 *
 * A successful report is persisted, so reopening the page or reloading the app
 * shows it at once and a stale one refreshes in the background. Only a key
 * with nothing cached waits for its first read, and the refresh button forces
 * one. Changing the range aborts the report scan it replaces, so two large
 * scans never compete; a runtime switch drops the in-memory entries, aborts
 * reads in flight, and hydrates that runtime's own persisted reports.
 *
 * `7d`/`30d` are relative to now: an entry reports the range it was fetched
 * for (`stats.range`) and when (`fetchedAt`), which the page shows.
 */

export type UsageStatsRequest = { range: UsageRange; projectDirectory: string | null };

export type UsageStatsEntry = {
  /** Last successful report; kept on screen through refreshes and failed refreshes. */
  stats: UsageStats | null;
  fetchedAt: number | null;
  loading: boolean;
  /** Message of the last failed read; cleared by the next success. */
  error: string | null;
};

export type UsageStatsFetcher = (request: UsageStatsRequest, signal: AbortSignal) => Promise<UsageStats>;

/** The part of `Storage` the page needs; `null` keeps reports in memory only. */
export type UsageStatsStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/** A cached report is served without a read for this long. */
export const USAGE_STATS_FRESH_MS = 5 * 60 * 1000;

const STORAGE_KEY = 'openchamber.usage-stats.v1';
const STORAGE_VERSION = 1;
const MAX_PERSISTED_ENTRIES = 8;
const MAX_PERSISTED_CHARS = 512 * 1024;

/**
 * Tool calls for a loaded report, fetched only on request: counting them makes
 * OpenCode read every tool call in the range. `range` is the loaded report's
 * window, so the tool numbers match the rest of the page.
 */
export type UsageToolsEntry = {
  tools: UsageTools | null;
  loading: boolean;
  /** Message of the last failed read; never shown as zero calls. */
  error: string | null;
};

export type UsageToolsFetcher = (
  request: UsageStatsRequest,
  range: UsageStats['range'],
  signal: AbortSignal,
) => Promise<UsageTools>;

export const usageStatsKey = (runtimeKey: string, request: UsageStatsRequest): string =>
  `${runtimeKey}::${request.range}::${request.projectDirectory ?? '__all__'}`;

type UsageStatsStore = {
  entries: Record<string, UsageStatsEntry>;
  /**
   * Loads a report for the request under the current runtime. Without `force`
   * this reads a key with no report, and refreshes a cached report in the
   * background once it is stale. A key whose last read failed waits for
   * `force` (the page's retry) instead of scanning again on every open.
   */
  load: (request: UsageStatsRequest, options?: { force?: boolean }) => Promise<void>;
  toolEntries: Record<string, UsageToolsEntry>;
  /**
   * Set once the user asks for tool calls; from then on every loaded report
   * fetches its tools after it lands, for the rest of the app session.
   */
  toolsRequested: boolean;
  /**
   * Loads tool calls for the request's loaded report. Without `force` this
   * only reads a key that has no tools, no error and no read running; with no
   * loaded report there is no window to count, so it does nothing.
   */
  loadTools: (request: UsageStatsRequest, options?: { force?: boolean }) => Promise<void>;
  /** Forgets the in-memory entries, aborts reads in flight, and hydrates the new runtime's cache. */
  reset: () => void;
};

const viewerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const fetchFromOpencode: UsageStatsFetcher = async ({ range, projectDirectory }, signal) => {
  // The `project` filter takes OpenCode's project id, which only OpenCode
  // knows: ask it for the id of the project's directory. A failed lookup is
  // an error for this choice, never an unfiltered or empty report.
  const projectID = projectDirectory ? await resolveUsageProjectID(projectDirectory) : undefined;
  signal.throwIfAborted();
  return fetchUsageStats({ from: rangeStart(range, new Date()), projectID, timezone: viewerTimeZone() }, signal);
};

const fetchToolsFromOpencode: UsageToolsFetcher = async ({ projectDirectory }, window, signal) => {
  const projectID = projectDirectory ? await resolveUsageProjectID(projectDirectory) : undefined;
  signal.throwIfAborted();
  return fetchUsageTools({ from: window.from, to: window.to, projectID, timezone: viewerTimeZone() }, signal);
};

type PersistedEntry = { key: string; stats: UsageStats; fetchedAt: number };

const toolTotalsSchema = z.object({
  calls: z.number().finite(),
  succeeded: z.number().finite(),
  failed: z.number().finite(),
  unfinished: z.number().finite(),
});

const usageTokensSchema = z.object({
  input: z.number().finite(),
  output: z.number().finite(),
  reasoning: z.number().finite(),
  cacheRead: z.number().finite(),
  cacheWrite: z.number().finite(),
  total: z.number().finite(),
});

const usageToolsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('summary'), totals: toolTotalsSchema }),
  z.object({
    mode: z.literal('detail'),
    totals: toolTotalsSchema,
    usage: z.array(toolTotalsSchema.extend({
      name: z.string(),
      durationP50: z.number().finite().nullable(),
    })),
  }),
]);

const usageModelSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().nullable(),
  steps: z.number().finite(),
  tokens: usageTokensSchema,
  cost: z.number().finite(),
});

const usageStatsSchema: z.ZodType<UsageStats> = z.object({
  range: z.object({ from: z.number().finite(), to: z.number().finite() }),
  sessions: z.number().finite(),
  subagents: z.number().finite(),
  prompts: z.number().finite(),
  steps: z.number().finite(),
  tokens: usageTokensSchema,
  cost: z.number().finite(),
  tools: usageToolsSchema,
  activeDays: z.number().finite(),
  streak: z.number().finite(),
  activity: z.array(z.object({ date: z.string(), steps: z.number().finite() })),
  models: z.array(usageModelSchema),
});

/**
 * Persisted reports are external input: an old build, a corrupt value or a
 * write cut short must read as no cache instead of crashing the page.
 */
const persistedPayloadSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  entries: z.array(z.object({
    key: z.string(),
    stats: usageStatsSchema,
    fetchedAt: z.number().finite(),
  })),
});

const readPersistedPayload = (storage: UsageStatsStorage | null): PersistedEntry[] => {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = persistedPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.entries : [];
  } catch {
    return [];
  }
};

const writePersistedPayload = (storage: UsageStatsStorage | null, entries: PersistedEntry[]) => {
  if (!storage) return;
  const newest = [...entries]
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .slice(0, MAX_PERSISTED_ENTRIES);
  while (newest.length > 0
    && JSON.stringify({ version: STORAGE_VERSION, entries: newest }).length > MAX_PERSISTED_CHARS) {
    newest.pop();
  }
  try {
    if (newest.length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, entries: newest }));
  } catch {
    // A full or blocked storage only loses the reload shortcut.
  }
};

const readPersistedEntries = (
  storage: UsageStatsStorage | null,
  runtimeKey: string,
) => {
  const prefix = `${runtimeKey}::`;
  const entries: Record<string, UsageStatsEntry> = {};
  for (const persisted of readPersistedPayload(storage)) {
    if (!persisted.key.startsWith(prefix)) continue;
    entries[persisted.key] = {
      stats: persisted.stats,
      fetchedAt: persisted.fetchedAt,
      loading: false,
      error: null,
    };
  }
  return entries;
};

export function createUsageStatsStore(
  fetcher: UsageStatsFetcher,
  runtimeKey: () => string,
  now: () => number = Date.now,
  toolsFetcher: UsageToolsFetcher = fetchToolsFromOpencode,
  storage: UsageStatsStorage | null = null,
) {
  // Bumped on reset, so reads from a previous runtime can neither commit nor
  // keep a key marked as loading.
  let generation = 0;
  // One report is on screen at a time: a read for another key aborts the scan
  // it replaces, including when the new key is already cached.
  let activeStatsKey: string | null = null;
  let statsController = new AbortController();
  // Tool reads stay independent: changing the range aborts the report scan,
  // not a tool scan the user already asked for.
  let toolsController = new AbortController();

  return create<UsageStatsStore>()((set, get) => {
    const patch = (key: string, next: Partial<UsageStatsEntry>) =>
      set((state) => {
        const previous = state.entries[key] ?? { stats: null, fetchedAt: null, loading: false, error: null };
        return { entries: { ...state.entries, [key]: { ...previous, ...next } } };
      });

    const patchTools = (key: string, next: Partial<UsageToolsEntry>) =>
      set((state) => {
        const previous = state.toolEntries[key] ?? { tools: null, loading: false, error: null };
        return { toolEntries: { ...state.toolEntries, [key]: { ...previous, ...next } } };
      });

    /**
     * Writes this runtime's reports over its previous ones and keeps what is
     * already in storage: the other runtimes' reports, and this runtime's
     * reports written by another window and never hydrated here. A newer
     * in-memory copy wins over the stored one.
     */
    const persist = () => {
      if (!storage) return;
      const prefix = `${runtimeKey()}::`;
      const merged = new Map<string, PersistedEntry>();
      for (const stored of readPersistedPayload(storage)) {
        merged.set(stored.key, stored);
      }
      for (const [key, entry] of Object.entries(get().entries)) {
        if (!key.startsWith(prefix) || !entry.stats || entry.fetchedAt === null) continue;
        const stored = merged.get(key);
        if (!stored || entry.fetchedAt >= stored.fetchedAt) {
          merged.set(key, { key, stats: entry.stats, fetchedAt: entry.fetchedAt });
        }
      }
      writePersistedPayload(storage, [...merged.values()]);
    };

    return {
      entries: readPersistedEntries(storage, runtimeKey()),
      toolEntries: {},
      toolsRequested: false,

      load: async (request, options) => {
        const key = usageStatsKey(runtimeKey(), request);
        // The visible range changed: stop a scan the page no longer shows,
        // even when the new key can answer from its cache.
        if (activeStatsKey !== null && activeStatsKey !== key) {
          statsController.abort();
          activeStatsKey = null;
        }
        const entry = get().entries[key];
        if (entry?.loading) return;
        if (!options?.force) {
          // A failed read is retried only on request; otherwise every open of
          // the page would start another multi-minute scan.
          if (entry?.error) return;
          // A report stamped ahead of the clock is not fresh: the clock moved
          // back, and waiting for it to catch up would serve old numbers.
          const age = entry?.stats && entry.fetchedAt !== null ? now() - entry.fetchedAt : -1;
          if (age >= 0 && age < USAGE_STATS_FRESH_MS) return;
        }

        const startGeneration = generation;
        activeStatsKey = key;
        statsController.abort();
        statsController = new AbortController();
        const { signal } = statsController;
        patch(key, { loading: true });
        try {
          const stats = await fetcher(request, signal);
          if (signal.aborted || startGeneration !== generation) return;
          // Written under the key the read started for: switching filters
          // while it runs never lets it land on another filter.
          patch(key, { stats, fetchedAt: now(), loading: false, error: null });
          persist();
          // A refreshed report moves the window, so tools already shown follow it.
          if (get().toolsRequested) void get().loadTools(request, { force: Boolean(get().toolEntries[key]?.tools) });
        } catch (error) {
          if (signal.aborted || startGeneration !== generation) return;
          // A failed read keeps the last report; it never becomes zeros.
          patch(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
          // The scan a filter change replaced still owns its key; without this
          // the key would stay "loading" and never read again.
          if (signal.aborted && startGeneration === generation) patch(key, { loading: false });
        }
      },

      loadTools: async (request, options) => {
        const key = usageStatsKey(runtimeKey(), request);
        const window = get().entries[key]?.stats?.range;
        if (!window) return;
        set({ toolsRequested: true });
        const entry = get().toolEntries[key];
        if (entry?.loading) return;
        if (!options?.force && (entry?.tools || entry?.error)) return;

        const startGeneration = generation;
        const { signal } = toolsController;
        // The report on screen can be replaced by a refresh that lands while
        // this read runs. Counts for the old window must not be committed
        // under the new one; they are dropped and counted again.
        const reportWindowChanged = () => {
          const current = get().entries[key]?.stats?.range;
          return !current || current.from !== window.from || current.to !== window.to;
        };
        const retryForCurrentWindow = () => {
          patchTools(key, { loading: false });
          void get().loadTools(request, { force: true });
        };
        patchTools(key, { loading: true });
        try {
          const tools = await toolsFetcher(request, window, signal);
          if (signal.aborted || startGeneration !== generation) return;
          if (reportWindowChanged()) {
            retryForCurrentWindow();
            return;
          }
          patchTools(key, { tools, loading: false, error: null });
        } catch (error) {
          if (signal.aborted || startGeneration !== generation) return;
          if (reportWindowChanged()) {
            retryForCurrentWindow();
            return;
          }
          patchTools(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (signal.aborted && startGeneration === generation) patchTools(key, { loading: false });
        }
      },

      reset: () => {
        generation += 1;
        activeStatsKey = null;
        statsController.abort();
        toolsController.abort();
        statsController = new AbortController();
        toolsController = new AbortController();
        set({
          entries: readPersistedEntries(storage, runtimeKey()),
          toolEntries: {},
        });
      },
    };
  });
}

export const useUsageStatsStore = createUsageStatsStore(
  fetchFromOpencode,
  getRuntimeKey,
  Date.now,
  fetchToolsFromOpencode,
  getSafeStorage(),
);

export const selectUsageToolsEntry = (
  state: Pick<UsageStatsStore, 'toolEntries'>,
  request: UsageStatsRequest,
): UsageToolsEntry | undefined => state.toolEntries[usageStatsKey(getRuntimeKey(), request)];

export const selectUsageStatsEntry = (
  state: Pick<UsageStatsStore, 'entries'>,
  request: UsageStatsRequest,
): UsageStatsEntry | undefined => state.entries[usageStatsKey(getRuntimeKey(), request)];

subscribeRuntimeEndpointChanged(() => useUsageStatsStore.getState().reset());
