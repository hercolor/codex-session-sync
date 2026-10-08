// src/api/config.js — GET /api/config, PUT /api/config
import { Router } from 'express';
import { getDefaultConfigPath, mergeConfig, saveConfig, validateConfig } from '../config.js';

export const router = Router();

const SECTIONS = new Set(['sync', 'conflict', 'backup', 'webdav', 'server', 'logging']);
const FIELDS = new Set([
  'codex_home', 'claude_home', 'machine_id', 'manifest_path', 'claude_manifest_path',
  'claude_remote_path', 'backup_dir', ...SECTIONS,
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configPath(req) {
  return req.app.locals.configPath || getDefaultConfigPath();
}

router.get('/', (req, res) => {
  const cfg = structuredClone(req.app.locals.cfg);
  // mask passwords
  if (cfg.webdav?.password) cfg.webdav.password = '***';
  cfg.config_path = configPath(req);
  res.json(cfg);
});

router.put('/', (req, res) => {
  const cfg = req.app.locals.cfg;
  if (!isObject(req.body)) {
    return res.status(400).json({ error: 'config updates must be an object' });
  }
  for (const [key, value] of Object.entries(req.body)) {
    if (!FIELDS.has(key)) {
      return res.status(400).json({ error: `Unknown config field: ${key}` });
    }
    if (SECTIONS.has(key) && !isObject(value)) {
      return res.status(400).json({ error: `${key} must be an object` });
    }
    if (!SECTIONS.has(key) && typeof value !== 'string') {
      return res.status(400).json({ error: `${key} must be a string` });
    }
  }
  let updates;
  let candidate;
  try {
    updates = mergeConfig({}, req.body);
    // An unchanged masked field or a blank input never replaces the saved secret.
    if (updates.webdav?.password === '***' || updates.webdav?.password === '') {
      delete updates.webdav.password;
    }
    candidate = mergeConfig(cfg, updates);
    const errors = validateConfig(candidate);
    if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    saveConfig(configPath(req), updates);
  } catch (error) {
    return res.status(500).json({ error: `Failed to save config: ${error.message}` });
  }
  // Keep the shared object used by the other API routers up to date only after saving.
  Object.assign(cfg, candidate);
  res.json({ ok: true, config_path: configPath(req) });
});
