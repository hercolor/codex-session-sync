// src/sync-engine.js — 同步计划生成与执行（纯逻辑层，便于测试）
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 计算 Buffer 的 SHA-256 hex
 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 判断两个文件条目的 mtime 是否在容差范围内相等
 */
function mtimeEqual(a, b, toleranceMs) {
  return Math.abs(a.mtime - b.mtime) <= toleranceMs;
}

/**
 * 归一化文件集合：数组 [{rel,...}] → 对象 { [rel]: {...} }
 */
function toFileMap(files) {
  if (!files) return {};
  if (Array.isArray(files)) {
    const map = {};
    for (const f of files) { if (f?.rel) map[f.rel] = f; }
    return map;
  }
  return files;
}

function isSafeRelativePath(rel) {
  return typeof rel === 'string' && rel.length > 0 &&
    !rel.startsWith('/') && !/^[a-z]:/i.test(rel) && !rel.includes('\\') &&
    rel.split('/').every((part) => part && part !== '.' && part !== '..');
}

// ─── buildPlan ────────────────────────────────────────────────────────────────

/**
 * 纯函数：对比本地和远端文件集合，生成同步计划
 *
 * @param {{
 *   localFiles:  Object<string, { mtime, size, sha256? }>,
 *   remoteFiles: Object<string, { mtime, size, sha256? }>,
 *   baseline?:   Object|string manifest — last successful sync observations,
 *   config:      object  — 包含 sync.compare / sync.time_tolerance_seconds / conflict.policy
 * }} params
 *
 * @returns {{
 *   to_upload:   string[],
 *   to_download: string[],
 *   conflicts:   Array<{ rel, local, remote }>,
 *   unchanged:   string[]
 * }}
 */
export function buildPlan({ localFiles, remoteFiles, config, baseline }) {
  // 兼容两种输入：数组 [{rel,mtime,size}] 或对象 { [rel]: {mtime,size} }
  localFiles  = toFileMap(localFiles);
  remoteFiles = toFileMap(remoteFiles);
  const compare   = config?.sync?.compare ?? 'mtime';
  const toleranceMs = (config?.sync?.time_tolerance_seconds ?? 2) * 1000;
  const direction = ['push', 'pull', 'bidirectional'].includes(config?.sync?.direction)
    ? config.sync.direction
    : 'bidirectional';
  const baselineFiles = toBaselineMap(baseline);

  const to_upload   = [];
  const to_download = [];
  const conflicts   = [];
  const unchanged   = [];

  // 合并所有 rel 键
  const allRels = new Set([
    ...Object.keys(localFiles),
    ...Object.keys(remoteFiles),
    ...Object.keys(baselineFiles ?? {}),
  ]);

  for (const rel of allRels) {
    const local  = localFiles[rel]  ?? null;
    const remote = remoteFiles[rel] ?? null;

    const baselineEntry = baselineFiles?.[rel];
    const decision = direction === 'bidirectional'
      ? (baselineEntry
        ? compareWithBaseline(local, remote, baselineEntry, { compare, toleranceMs })
        : compareCurrent(local, remote, { compare, toleranceMs }))
      : compareDirected(local, remote, baselineEntry, {
        direction,
        compare,
        toleranceMs,
      });

    if (decision === 'upload') {
      to_upload.push(rel);
    } else if (decision === 'download') {
      to_download.push(rel);
    } else if (decision === 'conflict') {
      conflicts.push({ rel, local, remote });
    } else {
      unchanged.push(rel);
    }
  }

  return { to_upload, to_download, conflicts, unchanged };
}

/** Compare a pair without a prior sync baseline (the original behavior). */
function compareCurrent(local, remote, options) {
  if (!remote) return 'upload';
  if (!local) return 'download';
  return compareFiles(local, remote, options);
}

/**
 * Compare in one-way repository mode. The selected side is authoritative:
 * push only propagates local changes, while pull refreshes local files from
 * the remote copy. Destination-only files are left alone so a first pull or
 * push cannot delete unrelated local data.
 */
function compareDirected(local, remote, baselineEntry, { direction, compare, toleranceMs }) {
  if (direction === 'push') {
    if (!local) return 'equal';
    if (!remote) return 'upload';
    if (!baselineEntry) {
      return compareFiles(local, remote, { compare, toleranceMs }) === 'equal'
        ? 'equal'
        : 'upload';
    }
    const { local: previousLocal } = baselineSides(baselineEntry);
    return metadataEqual(local, previousLocal) ? 'equal' : 'upload';
  }

  if (!remote) return 'equal';
  if (!local) return 'download';
  if (!baselineEntry) {
    return compareFiles(local, remote, { compare, toleranceMs }) === 'equal'
      ? 'equal'
      : 'download';
  }
  const { local: previousLocal, remote: previousRemote } = baselineSides(baselineEntry);
  const remoteChanged = !metadataEqual(remote, previousRemote);
  const localChanged = !metadataEqual(local, previousLocal);
  return remoteChanged || localChanged ? 'download' : 'equal';
}

/**
 * Compare current observations against the last successful sync. A change on
 * only one side is safe to propagate; changes on both sides require conflict
 * handling even when one mtime happens to be newer.
 */
function compareWithBaseline(local, remote, baselineEntry, options) {
  const { local: previousLocal, remote: previousRemote } = baselineSides(baselineEntry);
  const localChanged = !metadataEqual(local, previousLocal);
  const remoteChanged = !metadataEqual(remote, previousRemote);

  // Both sides disappearing is an already-applied deletion (or an incomplete
  // baseline entry); with delete_policy=never there is no action to schedule.
  if (!local && !remote) return 'equal';

  if (!localChanged && !remoteChanged) {
    // The side-specific baseline is authoritative here. The two endpoints
    // may legitimately report different mtimes after a WebDAV upload.
    return 'equal';
  }

  if (localChanged && remoteChanged) {
    if (local && remote && compareFiles(local, remote, options) === 'equal') return 'equal';
    return 'conflict';
  }

  // With delete_policy=never there is no delete operation, so restore a
  // surviving side rather than silently losing the file.
  if (localChanged) return local ? 'upload' : 'download';
  return remote ? 'download' : 'upload';
}

function baselineSides(entry) {
  if (entry && typeof entry === 'object' && ('local' in entry || 'remote' in entry)) {
    return { local: entry.local ?? null, remote: entry.remote ?? null };
  }
  // Early manifests stored one metadata object per path; treat it as both
  // observations for backwards compatibility.
  return { local: entry ?? null, remote: entry ?? null };
}

function metadataEqual(current, previous) {
  if (!current && !previous) return true;
  if (!current || !previous) return false;
  if (current.sha256 && previous.sha256) return current.sha256 === previous.sha256;
  // A WebDAV listing often has no content hash. When the baseline has one,
  // missing the current hash is unknown, not proof that the content is equal.
  // The service hashes the remote body when it needs a definitive decision.
  if (previous.sha256 && !current.sha256) return false;
  return current.mtime === previous.mtime && current.size === previous.size;
}

function toBaselineMap(baseline) {
  if (!baseline) return null;
  if (baseline.files && typeof baseline.files === 'object') return baseline.files;
  if (typeof baseline === 'object' && !Array.isArray(baseline)) return baseline;
  return null;
}

/**
 * 比较两个文件条目
 * @returns {'equal'|'upload'|'download'|'conflict'}
 */
function compareFiles(local, remote, { compare, toleranceMs }) {
  // A content hash is stronger than filesystem metadata. This matters when a
  // WebDAV server or another device assigns a different mtime to the same
  // uploaded session file.
  const hashesMatch = local.sha256 && remote.sha256 && local.sha256 === remote.sha256;
  const hashesDiffer = local.sha256 && remote.sha256 && local.sha256 !== remote.sha256;
  if (hashesMatch) return 'equal';
  if (hashesDiffer) return 'conflict';

  // 大小相同且 mtime 相差在容差内：视为相同（mtime 模式）
  if (local.size === remote.size && mtimeEqual(local, remote, toleranceMs)) {
    if (compare === 'mtime') return 'equal';
    // mtime_hash_fallback：mtime 接近时比较 hash
    if (compare === 'mtime_hash_fallback') {
      if (local.sha256 && remote.sha256) {
        return 'conflict';
      }
      // 缺少 hash 时按 mtime 逻辑处理
      return 'equal';
    }
  }

  // 大小不同或 mtime 超出容差：取更新的一方
  if (local.mtime > remote.mtime + toleranceMs) return 'upload';
  if (remote.mtime > local.mtime + toleranceMs) return 'download';

  // mtime 接近但大小不同：冲突
  return 'conflict';
}

// ─── applyPlan ────────────────────────────────────────────────────────────────

/**
 * 执行同步计划
 *
 * @param {{
 *   plan:       ReturnType<buildPlan>,
 *   config:     object,
 *   localBase:  string,   — 本地根目录绝对路径
 *   remoteBase: string,   — 远端根路径（WebDAV）
 *   webdavClient: object, — src/webdav-client.js 导出的 client 实例
 *   onProgress: (info: { file, action, n, total }) => void
 * }} params
 *
 * @returns {Promise<{ uploaded, downloaded, skipped, errors, uploaded_files, downloaded_files }>}
 */
export async function applyPlan({
  plan,
  config,
  localBase,
  remoteBase,
  webdavClient,
  davClient,            // 别名参数，兼容调用方
  onProgress = () => {},
}) {
  webdavClient = webdavClient ?? davClient;
  const conflictPolicy = config?.conflict?.policy ?? 'manual_abort';
  const backupEnabled  = config?.backup?.enabled ?? false;
  const remoteBackupRun = backupEnabled
    ? `remote-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : null;

  let uploaded = 0, downloaded = 0, skipped = plan.unchanged?.length ?? 0;
  const uploaded_files = [];
  const downloaded_files = [];
  const errors = [];

  // 解析冲突
  let effectivePlan = { ...plan };
  if (plan.conflicts.length > 0) {
    const resolved = resolveConflicts(plan.conflicts, conflictPolicy);
    effectivePlan = {
      to_upload:   [...plan.to_upload,   ...resolved.to_upload],
      to_download: [...plan.to_download, ...resolved.to_download],
      conflicts:   resolved.remaining,
      unchanged:   plan.unchanged,
    };
  }

  // Never advance the baseline while unresolved conflicts remain, regardless
  // of whether the configured policy name is recognized.
  if (effectivePlan.conflicts.length > 0) {
    for (const c of effectivePlan.conflicts) {
      errors.push({ rel: c.rel, reason: 'conflict', detail: c });
    }
    return { uploaded, downloaded, skipped, errors, uploaded_files, downloaded_files };
  }

  const total =
    effectivePlan.to_upload.length +
    effectivePlan.to_download.length +
    (effectivePlan.conflicts?.length ?? 0);
  let n = 0;

  // 上传
  // 注意：webdavClient 内部已拼接 remote_path 前缀，这里直接传 rel
  for (const rel of effectivePlan.to_upload) {
    n++;
    onProgress({ file: rel, action: 'upload', n, total });
    try {
      if (!isSafeRelativePath(rel)) throw new Error(`Unsafe relative path: ${rel}`);
      const localPath = join(localBase, rel);
      if (backupEnabled) await backupRemote(webdavClient, rel, config, remoteBackupRun);
      const buf = readFileSync(localPath);
      await webdavClient.putFile(rel, buf);
      uploaded++;
      uploaded_files.push(rel);
    } catch (err) {
      errors.push({ rel, action: 'upload', reason: err.message });
    }
  }

  // 下载
  for (const rel of effectivePlan.to_download) {
    n++;
    onProgress({ file: rel, action: 'download', n, total });
    try {
      if (!isSafeRelativePath(rel)) throw new Error(`Unsafe relative path: ${rel}`);
      const localPath = join(localBase, rel);
      const buf = await webdavClient.getFile(rel);
      if (backupEnabled) backupLocal(localPath, config);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, buf);
      downloaded++;
      downloaded_files.push(rel);
    } catch (err) {
      errors.push({ rel, action: 'download', reason: err.message });
    }
  }

  return { uploaded, downloaded, skipped, errors, uploaded_files, downloaded_files };
}

// ─── 冲突解决 ─────────────────────────────────────────────────────────────────

/**
 * 根据策略把 conflicts 分流到 to_upload / to_download / remaining
 */
function resolveConflicts(conflicts, policy) {
  const to_upload = [], to_download = [], remaining = [];

  for (const c of conflicts) {
    if (policy === 'prefer_local') {
      to_upload.push(c.rel);
    } else if (policy === 'prefer_cloud') {
      to_download.push(c.rel);
    } else if (policy === 'prefer_newer_mtime') {
      if ((c.local?.mtime ?? 0) >= (c.remote?.mtime ?? 0)) {
        to_upload.push(c.rel);
      } else {
        to_download.push(c.rel);
      }
    } else {
      // manual_abort 或未知策略：保留为冲突
      remaining.push(c);
    }
  }

  return { to_upload, to_download, remaining };
}

// ─── 备份辅助 ─────────────────────────────────────────────────────────────────

/**
 * 覆盖前备份本地文件（写入 .bak 副本）
 */
function backupLocal(localPath, _config) {
  if (!existsSync(localPath)) return;
  try {
    copyFileSync(localPath, localPath + '.bak');
  } catch (error) {
    throw new Error(`Unable to back up local file ${localPath}: ${error.message}`);
  }
}

/**
 * 覆盖前把远端文件保存到本机 backup_dir/.remote-overwrites。
 * 远端不存在时不创建备份；其他读取或写入错误会阻止覆盖。
 */
async function backupRemote(webdavClient, remotePath, config = {}, runId) {
  if (!isSafeRelativePath(remotePath)) {
    throw new Error(`Unsafe relative path: ${remotePath}`);
  }
  try {
    const buf = await webdavClient.getFile(remotePath);
    if (!buf) return;
    const backupRoot = config.backup_dir || join(process.cwd(), '.cxsync-backups');
    const backupRun = runId || `remote-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const target = join(backupRoot, '.remote-overwrites', backupRun, remotePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);
  } catch (error) {
    const status = error?.status ?? error?.response?.status ?? error?.response?.statusCode;
    if (status === 404 || /\b404\b|not found/i.test(error?.message ?? '')) return;
    throw new Error(`Unable to back up remote file ${remotePath}: ${error.message}`);
  }
}

/**
 * 拼接远端路径（避免双斜线）
 */
function joinRemote(base, rel) {
  return base.replace(/\/$/, '') + '/' + rel.replace(/^\//, '');
}

// 别名导出，兼容 buildSyncPlan 命名
export { buildPlan as buildSyncPlan };
