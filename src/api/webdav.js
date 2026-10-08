// src/api/webdav.js — POST /api/config/webdav/test
import { Router } from 'express';
import { createWebDAVClient } from '../webdav-client.js';
import { configForClient } from '../config.js';

export const router = Router();

router.post('/webdav/test', async (req, res) => {
  const { url, username, password, remote_path = '/', client = 'codex' } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const cfg = req.app.locals.cfg;
    const selected = configForClient({
      ...cfg,
      webdav: {
        url,
        username,
        password: password || cfg.webdav?.password,
        remote_path,
      },
    }, client);
    const dav = createWebDAVClient(selected.webdav);
    const result = await dav.testConnection();
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
