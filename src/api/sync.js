// src/api/sync.js — POST /api/sync/plan, POST /api/sync/apply (SSE)
import { Router } from 'express';
import { prepareSync, applySync } from '../sync-service.js';
import { isCodexRunning, isClaudeRunning } from '../process-check.js';
import { configForClient } from '../config.js';
import { sseStream } from '../server.js';

export const router = Router();

router.post('/plan', async (req, res) => {
  try {
    const cfg = configForClient(req.app.locals.cfg, req.body?.client);
    const state = await prepareSync(cfg);
    res.json({
      plan: state.plan,
      client: cfg.sync_client,
      incremental: true,
      baseline: state.baselineSource,
    });
  } catch (e) {
    res.status(/Unknown sync client/.test(e.message) ? 400 : 500).json({ error: e.message });
  }
});

router.post('/apply', async (req, res) => {
  const log = req.app.locals.log;
  const sse = sseStream(res);

  try {
    const cfg = configForClient(req.app.locals.cfg, req.body?.client);
    const running = cfg.sync_client === 'claude'
      ? await isClaudeRunning()
      : await isCodexRunning();
    if (running) {
      sse.send({ type: 'error', message: `${cfg.sync_client === 'claude' ? 'Claude Code' : 'Codex'} is running — close it before syncing` });
      sse.end(); return;
    }

    const state = await prepareSync(cfg);
    const { plan } = state;

    const total = plan.to_upload.length + plan.to_download.length + plan.conflicts.length;
    sse.send({ type: 'start', total, client: cfg.sync_client, incremental: true, baseline: state.baselineSource });
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
