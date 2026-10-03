import { describe, expect, test } from 'bun:test';
import { isSessionGoalMaxAutoTurns } from './sessionGoalTurnLimit';

describe('goal turn limit', () => {
  test('accepts whole numbers from 0 to 10000, 0 meaning unlimited', () => {
    expect([0, 1, 20, 200, 10_000].map(isSessionGoalMaxAutoTurns)).toEqual([true, true, true, true, true]);
    expect([-1, 10_001, 2.5, Number.NaN].map(isSessionGoalMaxAutoTurns)).toEqual([false, false, false, false]);
  });
});
