/**
 * Whether a session's turn has really ended.
 *
 * A parent session goes idle while a background subagent keeps working in a
 * child session. When the child finishes, OpenCode delivers its result to the
 * parent, which runs again and goes idle a second time. So the parent's first
 * idle is a pause, not the end of the turn: anything that treats idle as
 * "done" (goal audits, ready notifications) has to check the running subagent
 * sessions too — from the live active list, never from the parent's child
 * history, which can grow to thousands of sessions.
 *
 * Every read answers `null` when OpenCode could not be asked: "could not look"
 * must never pass for "nothing is running".
 */

import { unwrapOpenCodeResponse } from './response-envelope.js';
import { z } from 'zod';

const MAX_SUBAGENT_DEPTH = 8;
const sessionLineageSchema = z.object({ id: z.string().min(1), parentID: z.string().min(1).nullish() });

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch }) => {
  const openCodeGet = async (fetchPath, query, signal = AbortSignal.timeout(timeoutMs)) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const response = await fetchImpl(search ? `${base}?${search}` : base, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenCode GET ${fetchPath} failed with ${response.status}`);
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  /**
   * `/api/session/active` is global and lists only the sessions running right
   * now (`{ data: { [id]: status } }`), so an absent id is idle.
   */
  const fetchActiveSessionStatuses = async () => {
    const statuses = await openCodeGet('/api/session/active').catch(() => null);
    return statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? statuses : null;
  };

  /**
   * True when a subagent of the session is still running — nested ones
   * included, because an intermediate session idles while its own subagent
   * works — and null when unknown. The walk starts from the sessions OpenCode
   * reports as active and follows each one's parent chain, so a parent whose
   * child history is too long to list (thousands of sessions) still gets an
   * answer instead of `null`. A chain deeper than `MAX_SUBAGENT_DEPTH` counts
   * as unrelated, as in the UI's ancestor walk, so a deep tree elsewhere
   * cannot hold every consumer. Unreadable lineage and cycles are unknown.
   */
  const hasWorkingDescendants = async (sessionId, statuses) => {
    const parents = new Map();
    const signal = AbortSignal.timeout(timeoutMs);
    let unknown = false;
    for (const activeId of Object.keys(statuses)) {
      if (activeId === sessionId) continue;
      let current = activeId;
      const visited = new Set();
      for (let depth = 0; current && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
        if (signal.aborted) return null;
        if (visited.has(current)) {
          unknown = true;
          break;
        }
        visited.add(current);
        if (!parents.has(current)) {
          const body = await openCodeGet(`/api/session/${encodeURIComponent(current)}`, undefined, signal).catch(() => null);
          const parsed = sessionLineageSchema.safeParse(body);
          parents.set(current, parsed.success && parsed.data.id === current ? parsed.data.parentID ?? null : undefined);
        }
        const parentId = parents.get(current);
        if (parentId === undefined) {
          unknown = true;
          break;
        }
        if (parentId === sessionId) return true;
        current = parentId;
      }
    }
    return unknown ? null : false;
  };

  return { fetchActiveSessionStatuses, hasWorkingDescendants };
};
