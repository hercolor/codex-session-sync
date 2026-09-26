// src/api/sync.js — POST /api/sync/plan, POST /api/sync/apply (SSE)
import { Router } from 'express';
import { prepareSync, applySync } from '../sync-service.js';
import { isCodexRunning } from '../process-check.js';
import { sseStream } from '../server.js';

export const router = Router();

router.post('/plan', async (req, res) => {
  const cfg = req.app.locals.cfg;
  try {
    const state = await prepareSync(cfg);
    res.json({
      plan: state.plan,
      incremental: true,
      baseline: state.baselineSource,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/apply', async (req, res) => {
  const cfg = req.app.locals.cfg;
  const log = req.app.locals.log;
  const sse = sseStream(res);

  try {
    const running = await isCodexRunning();
    if (running) {
      sse.send({ type: 'error', message: 'Codex is running — close it before syncing' });
      sse.end(); return;
    }

    const state = await prepareSync(cfg);
    const { plan } = state;

    const total = plan.to_upload.length + plan.to_download.length + plan.conflicts.length;
    sse.send({ type: 'start', total, incremental: true, baseline: state.baselineSource });
    for (const conflict of plan.conflicts) {
      sse.send({ type: 'conflict', file: conflict.rel, policy: cfg.conflict?.policy ?? 'manual_abort' });
    }

    const result = await applySync(state, {
      log: (p) => log.info('sync progress', p),
      onProgress: (p) => sse.send({ type: 'progress', ...p, total }),
    });

    sse.send({ type: 'done', ...result, errors: result.errors.length });
  } catch (e) {
    log.error('sync error', { message: e.message });
    sse.send({ type: 'error', message: e.message });
  } finally {
    sse.end();
  }
});
