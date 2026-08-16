import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import {
    buildTaskSummaryEntriesFromSession,
    parseTaskMetadataBlock,
    readTaskSessionIdFromRecord,
    readTaskSessionIdFromOutput,
    resolveTaskToolEmptyState,
} from './taskToolModel';

describe('taskToolModel', () => {
    test('reads the current OpenCode running-state identity contract', () => {
        expect(readTaskSessionIdFromRecord({ sessionId: 'child-live' })).toBe('child-live');
        expect(readTaskSessionIdFromRecord({})).toBe(undefined);
    });

    test('reads authoritative session and summary metadata', () => {
        const output = 'result\n<task_metadata>{"sessionID":"child-1","calls":[{"id":"tool-1","tool":"read","title":"a.ts"}]}</task_metadata>';
        expect(parseTaskMetadataBlock(output)).toEqual({
            sessionId: 'child-1',
            summaryEntries: [{ id: 'tool-1', tool: 'read', state: { status: undefined, title: 'a.ts', input: undefined } }],
        });
        expect(readTaskSessionIdFromOutput(output)).toBe('child-1');
    });

    test('projects tool calls while excluding nested task and todo bookkeeping', () => {
        const message = {
            info: { id: 'message-1', role: 'assistant' } as Message,
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'a.ts' } } },
                { id: 'task-1', type: 'tool', tool: 'task', state: { status: 'running' } },
                { id: 'todo-1', type: 'tool', tool: 'todowrite', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        expect(buildTaskSummaryEntriesFromSession([message])).toEqual([{
            id: 'read-1',
            tool: 'read',
            state: { status: 'completed', title: undefined, input: { filePath: 'a.ts' } },
        }]);
    });
});

describe('resolveTaskToolEmptyState', () => {
    test('blocked-before-spawn task renders terminal BLOCKED state with the block reason', () => {
        const state = resolveTaskToolEmptyState({
            hasEntries: false,
            hasOutput: false,
            hasSessionId: false,
            isActive: false,
            error: 'project-memory gate: a worker is already delegated for this work',
        });
        expect(state).toEqual({ kind: 'blocked', reason: 'project-memory gate: a worker is already delegated for this work' });
    });

    test('a blocked-before-spawn task is terminal, never "waiting" or "missing metadata"', () => {
        const state = resolveTaskToolEmptyState({
            hasEntries: false,
            hasOutput: false,
            hasSessionId: false,
            isActive: false,
            error: 'project-memory gate: block',
        });
        expect(state.kind).toBe('blocked');
        expect(state.kind).not.toBe('waiting');
        expect(state.kind).not.toBe('missingMetadata');
    });

    test('an allowed task with a child session resolves to content (session link shown)', () => {
        const state = resolveTaskToolEmptyState({
            hasEntries: true,
            hasOutput: false,
            hasSessionId: true,
            isActive: false,
            error: undefined,
        });
        expect(state).toEqual({ kind: 'content' });
    });

    test('a finalized task with genuinely missing child metadata keeps the real error visible', () => {
        const state = resolveTaskToolEmptyState({
            hasEntries: false,
            hasOutput: false,
            hasSessionId: false,
            isActive: false,
            error: undefined,
        });
        expect(state).toEqual({ kind: 'missingMetadata' });
    });

    test('an active task with no content yet resolves to waiting, not blocked', () => {
        const state = resolveTaskToolEmptyState({
            hasEntries: false,
            hasOutput: false,
            hasSessionId: false,
            isActive: true,
            error: undefined,
        });
        expect(state).toEqual({ kind: 'waiting' });
    });

    test('no phantom running/polling after a block: error state never yields waiting', () => {
        const state = resolveTaskToolEmptyState({
            hasEntries: false,
            hasOutput: false,
            hasSessionId: false,
            isActive: false,
            error: 'project-memory gate: block',
        });
        expect(state.kind).toBe('blocked');
        expect(readTaskSessionIdFromRecord({})).toBe(undefined);
    });
});
