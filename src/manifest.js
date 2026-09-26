// src/manifest.js — 读写同步清单，记录已同步文件的元数据
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';

/** Current on-disk manifest format. */
export const MANIFEST_VERSION = 1;

/**
 * Resolve the local manifest path used by a sync invocation.
 *
 * `manifest_path` is intentionally separate from `codex_home`: the manifest
 * describes sync state and must not become part of the Codex data set.
 */
export function getManifestPath({ manifest_path, manifestPath, config, configPath, backup_dir, backupDir } = {}) {
  const explicit = manifest_path ?? manifestPath ?? config?.manifest_path;
  if (explicit) return resolveManifestPath(explicit);
  if (backup_dir ?? backupDir) return join(dirname(resolveManifestPath(backup_dir ?? backupDir)), 'manifest.json');
  if (configPath) return join(dirname(resolveManifestPath(configPath)), 'manifest.json');
  return join(homedir(), '.codex-session-sync', 'manifest.json');
}

// Alias kept for callers that prefer a verb-style name.
export const manifestPathForConfig = getManifestPath;

/**
 * 读取清单文件
 * @param {string} manifestPath
 * @returns {{ machine_id, synced_at, files: Object } | null}
 */
export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return normalizeManifest(parsed);
  } catch {
    return null;
  }
}

/**
 * 原子写清单：先写 .tmp，再 rename
 * @param {string} manifestPath
 * @param {{ machine_id, synced_at, files }} data
 */
export function writeManifest(manifestPath, data) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmpPath = manifestPath + '.tmp';
  const normalized = normalizeManifest(data);
  if (!normalized) throw new Error('Invalid sync manifest');
  writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf8');
  renameSync(tmpPath, manifestPath);
}

/**
 * Check and normalize a manifest object. Older manifests without an explicit
 * version are accepted as version 1 so upgrading does not discard a valid
 * local baseline. Unsupported versions are rejected by returning null.
 */
export function normalizeManifest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const version = data.version ?? data.schema_version ?? MANIFEST_VERSION;
  if (version !== MANIFEST_VERSION) return null;
  if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files)) return null;

  const files = Object.create(null);
  for (const [rel, entry] of Object.entries(data.files)) {
    if (!isSafeRelativePath(rel)) return null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    files[rel] = normalizeManifestEntry(entry);
  }

  return {
    version: MANIFEST_VERSION,
    machine_id: data.machine_id ?? null,
    synced_at: data.synced_at ?? null,
    files,
  };
}

/** Return true when `data` is a supported manifest object. */
export function isManifest(data) {
  return normalizeManifest(data) !== null;
}

/**
 * Build the baseline written after a successful sync.
 *
 * Each file keeps the observed metadata on both sides. WebDAV servers may
 * rewrite mtime during upload, so a single shared metadata value is not
 * sufficient for reliable change detection on the next run.
 */
export function buildManifest({
  machineId = 'default',
  machine_id,
  localFiles = [],
  remoteFiles = [],
  syncedAt = new Date().toISOString(),
  synced_at,
} = {}) {
  const local = buildFileMap(localFiles);
  const remote = buildFileMap(remoteFiles);
  const files = Object.create(null);
  const rels = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const rel of rels) {
    files[rel] = {
      local: local[rel] ?? null,
      remote: remote[rel] ?? null,
    };
  }

  return {
    version: MANIFEST_VERSION,
    machine_id: machine_id ?? machineId,
    synced_at: synced_at ?? syncedAt,
    files,
  };
}

// Explicit name for sync callers; both names describe the same operation.
export const buildSyncManifest = buildManifest;

/**
 * 从 scanner allFiles 生成 manifest files 对象
 * 不强制要求 sha256（计算成本高），可按需在调用侧补充
 * @param {Array<{ rel, absPath, mtime, size }>} fileList
 * @returns {Object<string, { mtime, size, sha256? }>}
 */
export function buildFileMap(fileList) {
  const files = Object.create(null);
  const entries = Array.isArray(fileList)
    ? fileList
    : Object.entries(fileList ?? {}).map(([rel, value]) => ({ rel, ...value }));
  for (const f of entries) {
    if (!f?.rel) continue;
    files[f.rel] = {
      mtime: f.mtime,
      size: f.size,
    };
    if (f.sha256) files[f.rel].sha256 = f.sha256;
  }
  return files;
}

function normalizeManifestEntry(entry) {
  // Canonical entries contain side-specific observations. Accepting a flat
  // entry keeps manifests produced by early development versions usable.
  if ('local' in entry || 'remote' in entry) {
    return {
      local: normalizeMetadata(entry.local),
      remote: normalizeMetadata(entry.remote),
    };
  }
  return normalizeMetadata(entry);
}

function normalizeMetadata(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = {};
  if (entry.mtime !== undefined) out.mtime = entry.mtime;
  if (entry.size !== undefined) out.size = entry.size;
  if (entry.sha256) out.sha256 = entry.sha256;
  return Object.keys(out).length ? out : null;
}

function isSafeRelativePath(rel) {
  return typeof rel === 'string' && rel.length > 0 &&
    !rel.startsWith('/') && !/^[a-z]:/i.test(rel) && !rel.includes('\\') &&
    rel.split('/').every((part) => part && part !== '.' && part !== '..');
}

function resolveManifestPath(path) {
  if (typeof path !== 'string') return resolve(String(path));
  return resolve(path.startsWith('~') ? join(homedir(), path.slice(2)) : path);
}

/**
 * 计算文件 SHA-256（同步，用于 hash 比较模式）
 * @param {string} filePath
 * @returns {string} hex digest
 */
export function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}
