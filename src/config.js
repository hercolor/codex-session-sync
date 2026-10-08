// src/config.js — load and validate config.yml
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';

const DEFAULTS = {
  codex_home: '~/.codex',
  claude_home: '~/.claude',
  machine_id: 'default',
  manifest_path: '~/.codex-session-sync/manifest.json',
  claude_manifest_path: '~/.codex-session-sync/claude-manifest.json',
  // Empty means a sibling of webdav.remote_path, e.g. /codex-sync-claude.
  claude_remote_path: '',
  sync: {
    mode: 'cold',
    direction: 'bidirectional',
    compare: 'mtime',
    time_tolerance_seconds: 2,
    equal_mtime_action: 'skip',
    delete_policy: 'never',
    // A handoff must include older sessions so `codex resume` can find the
    // complete history. Keep date filtering opt-in until it is implemented.
    session_mode: 'all',
  },
  conflict: { policy: 'manual_abort' },
  backup: {
    enabled: true,
    compression: 'none',
    retention_days: 30,
    max_backups: 0,
  },
  webdav: { url: '', username: '', password: '', remote_path: '/codex-sync' },
  server: { port: 7420, open_browser: true },
  logging: { level: 'INFO', file: '~/.codex-session-sync/logs/sync.log' },
};

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~') ? resolve(homedir(), p.slice(2)) : resolve(p);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source ?? {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(target[k] ?? {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(configPath) {
  let raw = {};
  if (configPath && existsSync(configPath)) {
    raw = yaml.load(readFileSync(configPath, 'utf8')) ?? {};
  }
  const merged = deepMerge(DEFAULTS, raw);
  // expand home in key paths
  merged.codex_home = expandHome(merged.codex_home);
  merged.claude_home = expandHome(merged.claude_home);
  merged.logging.file = expandHome(merged.logging.file);
  if (merged.manifest_path) merged.manifest_path = expandHome(merged.manifest_path);
  if (merged.claude_manifest_path) merged.claude_manifest_path = expandHome(merged.claude_manifest_path);
  // derive backup_dir next to config or in ~/.codex-session-sync
  if (!merged.backup_dir) {
    const base = configPath ? dirname(resolve(configPath)) : expandHome('~/.codex-session-sync');
    merged.backup_dir = resolve(base, 'backups');
  }
  return merged;
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['config must be an object'];
  if (!cfg.codex_home || typeof cfg.codex_home !== 'string') errors.push('codex_home is required');
  if (!cfg.manifest_path || typeof cfg.manifest_path !== 'string') errors.push('manifest_path is required');
  if (!cfg.claude_home || typeof cfg.claude_home !== 'string') errors.push('claude_home is required');
  if (!cfg.claude_manifest_path || typeof cfg.claude_manifest_path !== 'string') {
    errors.push('claude_manifest_path is required');
  }

  const sync = cfg.sync ?? {};
  if (!['cold'].includes(sync.mode)) errors.push('sync.mode must be cold');
  if (!['bidirectional', 'push', 'pull'].includes(sync.direction)) {
    errors.push('sync.direction must be bidirectional, push, or pull');
  }
  if (!['mtime', 'mtime_hash_fallback'].includes(sync.compare)) {
    errors.push('sync.compare must be mtime or mtime_hash_fallback');
  }
  if (!Number.isFinite(sync.time_tolerance_seconds) || sync.time_tolerance_seconds < 0) {
    errors.push('sync.time_tolerance_seconds must be a non-negative number');
  }
  if (!['never'].includes(sync.delete_policy)) errors.push('sync.delete_policy currently supports only never');
  if (sync.session_mode !== 'all') {
    errors.push('sync.session_mode must be all (date filtering is not implemented)');
  }

  const policy = cfg.conflict?.policy;
  if (!['manual_abort', 'prefer_local', 'prefer_cloud', 'prefer_newer_mtime'].includes(policy)) {
    errors.push('conflict.policy is invalid');
  }
  if (!cfg.webdav?.url || typeof cfg.webdav.url !== 'string') errors.push('webdav.url is required');
  if (!cfg.webdav?.remote_path || typeof cfg.webdav.remote_path !== 'string') {
    errors.push('webdav.remote_path is required');
  }
  if (cfg.claude_remote_path && typeof cfg.claude_remote_path !== 'string') {
    errors.push('claude_remote_path must be a string');
  }
  let codexRemotePath;
  let claudeRemotePath;
  if (typeof cfg.webdav?.remote_path === 'string' && cfg.webdav.remote_path) {
    try { codexRemotePath = normalizeRemotePath(cfg.webdav.remote_path); }
    catch { errors.push('webdav.remote_path contains unsafe path segments'); }
  }
  if (typeof cfg.claude_remote_path === 'string' && cfg.claude_remote_path) {
    try { claudeRemotePath = normalizeRemotePath(cfg.claude_remote_path); }
    catch { errors.push('claude_remote_path contains unsafe path segments'); }
  }
  if (codexRemotePath && claudeRemotePath && claudeRemotePath === codexRemotePath) {
    errors.push('claude_remote_path must differ from webdav.remote_path');
  }
  return errors;
}

function normalizeRemotePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || /[\x00-\x1f]/.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('WebDAV remote path contains unsafe path segments');
  }
  return `/${path.split('/').filter(Boolean).join('/')}`;
}

/** Select an independent local and WebDAV repository for each CLI client. */
export function configForClient(cfg, client = 'codex') {
  if (!['codex', 'claude'].includes(client)) {
    throw new Error(`Unknown sync client: ${client}`);
  }
  const codexRemotePath = normalizeRemotePath(cfg.webdav.remote_path);
  if (client === 'codex') {
    return { ...cfg, sync_client: client, local_home: cfg.codex_home };
  }

  const claudeRemotePath = cfg.claude_remote_path
    ? normalizeRemotePath(cfg.claude_remote_path)
    : codexRemotePath === '/' ? '/claude-sync' : `${codexRemotePath}-claude`;
  if (claudeRemotePath === codexRemotePath) {
    throw new Error('Claude remote path must differ from Codex remote path');
  }
  return {
    ...cfg,
    sync_client: client,
    local_home: cfg.claude_home,
    manifest_path: cfg.claude_manifest_path,
    webdav: { ...cfg.webdav, remote_path: claudeRemotePath },
  };
}

export function writeExampleConfig(dest) {
  const example = readFileSync(
    new URL('../config.example.yml', import.meta.url),
    'utf8'
  );
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, example, 'utf8');
}

export function getDefaultConfigPath() {
  return expandHome('~/.codex-session-sync/config.yml');
}
