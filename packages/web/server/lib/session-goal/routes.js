import { GOAL_OBJECTIVE_CHAR_LIMIT, deleteObjective, readObjective, writeObjective } from './objectives.js';

const resolveCharLimit = async (readSettingsFromDisk) => {
  if (typeof readSettingsFromDisk !== 'function') return GOAL_OBJECTIVE_CHAR_LIMIT;
  const settings = await readSettingsFromDisk().catch(() => null);
  const value = settings?.sessionGoalObjectiveCharLimit;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : GOAL_OBJECTIVE_CHAR_LIMIT;
};

// OpenChamber-owned routes for file-backed goal objectives, keyed by session
// id (one goal per session; a new goal overwrites the old file). The UI
// writes the objective file before stamping the goal metadata (which only
// carries an `objectiveFile: true` flag), reads it back for display, and
// deletes it when the goal is removed.
export function registerSessionGoalRoutes(app, { readSettingsFromDisk } = {}) {
  app.put('/api/goals/objective/:sessionId', async (req, res) => {
    try {
      const { content } = req.body || {};
      const limit = await resolveCharLimit(readSettingsFromDisk);
      await writeObjective(req.params.sessionId, content, limit);
      res.json({ ok: true });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Failed to write goal objective:', error);
      }
      res.status(statusCode).json({ error: error?.message || 'Failed to write goal objective' });
    }
  });

  app.get('/api/goals/objective/:sessionId', async (req, res) => {
    const limit = await resolveCharLimit(readSettingsFromDisk);
    const content = await readObjective(req.params.sessionId, limit);
    if (content === null) {
      res.status(404).json({ error: 'objective not found' });
      return;
    }
    res.json({ content });
  });

  app.delete('/api/goals/objective/:sessionId', async (req, res) => {
    await deleteObjective(req.params.sessionId);
    res.json({ ok: true });
  });
}
