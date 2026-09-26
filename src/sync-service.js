// src/sync-service.js - shared incremental sync workflow for CLI and API
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { scanCodexHome } from './scanner.js';
import { createWebDAVClient } from './webdav-client.js';
import { buildSyncPlan, applyPlan } from './sync-engine.js';
import {
  buildManifest,
  getManifestPath,
  hashFile,
  normalizeManifest,
  readManifest,
  writeManifest,
} from './manifest.js';

// This is sync metadata, not a Codex file. It is deliberately hidden from the
// user file list and is stored at the configured WebDAV root.
export const REMOTE_MANIFEST = '.cxsync-manifest.json';

/**
 * Read a remote manifest, treating a missing file as an uninitialized remote.
 * Other errors are fatal: an unreachable WebDAV endpoint must never look like
 * an empty remote and cause a destructive full upload.
 */
export async function readRemoteManifest(dav) {
  try {
    const data = await dav.getFile(REMOTE_MANIFEST);
    try {
      return readManifestBuffer(data);
    } catch (error) {
      throw new Error(`Invalid remote sync manifest: ${error.message}`);
    }
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error(`Unable to read remote sync manifest: ${error.message}`);
  }
}

function readManifestBuffer(data) {
  const text = Buffer.from(data).toString('utf8');
  const manifest = normalizeManifest(JSON.parse(text));
  if (!manifest) throw new Error('Invalid or unsupported manifest');
  return manifest;
}

function isNotFound(error) {
  const status = error?.status ?? error?.response?.status ?? error?.response?.statusCode;
  return status === 404 || /\b404\b|not found/i.test(error?.message ?? '');
}

function userFiles(files) {
  return (files ?? []).filter((entry) =>
    entry?.rel !== REMOTE_MANIFEST &&
    isSyncablePath(entry?.rel) &&
    !/\.(?:bak|tmp)$/i.test(entry?.rel ?? '')
  ).map((entry) => {
    if (!isSafeRelativePath(entry?.rel)) {
      throw new Error(`Unsafe relative path returned by WebDAV: ${entry?.rel ?? '(missing)'}`);
    }
    return entry;
  });
}

// Keep the WebDAV repository limited to portable Codex data. In particular,
// never pull auth.json, tokens, API keys, SQLite state, or unrelated files
// someone may have placed under the same WebDAV directory.
function isSyncablePath(rel) {
  return rel === 'session_index.jsonl' ||
    /^(?:sessions|skills|plugins)\//.test(rel ?? '');
}

function isSafeRelativePath(rel) {
  return typeof rel === 'string' && rel.length > 0 &&
    !rel.startsWith('/') && !/^[a-z]:/i.test(rel) && !rel.includes('\\') &&
    rel.split('/').every((part) => part && part !== '.' && part !== '..');
}

function addLocalHashes(files) {
  return files.map((file) => {
    try {
      return { ...file, sha256: hashFile(file.absPath) };
    } catch (error) {
      throw new Error(`Unable to hash local file ${file.rel}: ${error.message}`);
    }
  });
}

function addHashesForPaths(files, paths) {
  return files.map((file) => {
    if (!paths.has(file.rel)) return file;
    try { return { ...file, sha256: hashFile(file.absPath) }; }
    catch (error) { throw new Error(`Unable to hash local file ${file.rel}: ${error.message}`); }
  });
}

function addChangedLocalHashes(files, baseline) {
  return files.map((file) => {
    const entry = baseline?.files?.[file.rel];
    const previous = entry?.local ?? (entry && !('local' in entry || 'remote' in entry) ? entry : null);
    if (!previous?.sha256) return file;
    if (previous.mtime === file.mtime && previous.size === file.size) {
      return { ...file, sha256: previous.sha256 };
    }
    try { return { ...file, sha256: hashFile(file.absPath) }; }
    catch (error) { throw new Error(`Unable to hash local file ${file.rel}: ${error.message}`); }
  });
}

function carryLocalHashes(files, manifest) {
  return files.map((file) => {
    if (file.sha256) return file;
    const entry = manifest?.files?.[file.rel];
    const previous = entry?.local ?? (entry && !('local' in entry || 'remote' in entry) ? entry : null);
    return previous?.sha256 && previous.size === file.size && previous.mtime === file.mtime
      ? { ...file, sha256: previous.sha256 }
      : file;
  });
}

function hashBuffer(data) {
  return createHash('sha256').update(data).digest('hex');
}

function manifestHasHashes(manifest) {
  return Object.values(manifest?.files ?? {}).some((entry) => {
    const local = entry?.local ?? (entry && !('local' in entry || 'remote' in entry) ? entry : null);
    const remote = entry?.remote ?? null;
    return Boolean(local?.sha256 || remote?.sha256);
  });
}

function previousRemoteMetadata(manifest, rel) {
  const entry = manifest?.files?.[rel];
  if (!entry) return null;
  return entry.remote ?? (('local' in entry || 'remote' in entry) ? null : entry);
}

async function addRemoteHashes(dav, files, baseline, { localByRel, transferred, force = false } = {}) {
  const out = [];
  for (const file of files) {
    const previous = previousRemoteMetadata(baseline, file.rel);
    const localFile = localByRel?.get(file.rel);
    if (!force && transferred?.has(file.rel) && localFile?.sha256) {
      out.push({ ...file, sha256: localFile.sha256 });
      continue;
    }
    if (!force && previous?.sha256 && previous.size === file.size && previous.mtime === file.mtime) {
      out.push({ ...file, sha256: previous.sha256 });
      continue;
    }
    if (!force && !previous?.sha256) {
      out.push(file);
      continue;
    }
    try {
      out.push({ ...file, sha256: hashBuffer(await dav.getFile(file.rel)) });
    } catch (error) {
      throw new Error(`Unable to hash remote file ${file.rel}: ${error.message}`);
    }
  }
  return out;
}

/**
 * Scan both endpoints and build an incremental plan. A local manifest is
 * preferred for device-specific observations; the shared remote manifest is
 * retained as repository metadata and carries content hashes across machines.
 */
export async function prepareSync(cfg) {
  const local = await scanCodexHome(cfg.codex_home);
  const dav = createWebDAVClient(cfg.webdav);
  const remoteFilesRaw = userFiles(await dav.list());
  const remoteManifest = await readRemoteManifest(dav);
  const manifestPath = getManifestPath({
    manifest_path: cfg.manifest_path,
    backup_dir: cfg.backup_dir,
  });
  const localManifest = readManifest(manifestPath);
  // A remote manifest is a cache of the repository's observations, not a
  // history of this device. Without a local baseline, compare current content
  // directly after hashing it instead of treating another device's mtime as
  // this device's previous state.
  const baseline = localManifest;
  // Hashing is opt-in through the existing comparison mode. The default mtime
  // mode keeps the incremental scan metadata-only and avoids reading every
  // session body on each run.
  const forceHashes = cfg.sync?.compare === 'mtime_hash_fallback';
  const remoteHasHashes = manifestHasHashes(remoteManifest);
  // A new device must compare content when the repository already has files,
  // even if an older manifest has no hashes. This is a one-time cost that
  // prevents same-size, same-mtime files from being silently overwritten.
  const compareCrossDevice = !localManifest && remoteFilesRaw.length > 0;
  const hashBaseline = localManifest ?? remoteManifest;
  const forceRemoteHashes = forceHashes || compareCrossDevice;
  const localFiles = forceHashes || compareCrossDevice
    ? addLocalHashes(local.allFiles)
    : manifestHasHashes(localManifest)
      ? addChangedLocalHashes(local.allFiles, localManifest)
      : local.allFiles;
  const remoteFiles = forceRemoteHashes || remoteHasHashes
    ? await addRemoteHashes(dav, remoteFilesRaw, hashBaseline, { force: forceRemoteHashes })
    : remoteFilesRaw;
  const baselineSource = localManifest ? 'local' : 'none';
  const plan = buildSyncPlan({
    localFiles,
    remoteFiles,
    baseline,
    config: cfg,
  });

  return {
    cfg,
    local,
    dav,
    remoteFiles,
    remoteManifest,
    localManifest,
    manifestPath,
    baseline,
    baselineSource,
    compareCrossDevice,
    plan,
  };
}

/**
 * Apply a prepared plan and atomically persist a new shared baseline after all
 * file operations succeed. Metadata is refreshed after transfer because a
 * WebDAV server may assign its own mtime to uploaded files.
 */
export async function applySync(state, { onProgress = () => {}, log } = {}) {
  const { cfg, dav, manifestPath, plan } = state;
  const result = await applyPlan({
    plan,
    config: cfg,
    localBase: cfg.codex_home,
    remoteBase: cfg.webdav.remote_path,
    davClient: dav,
    onProgress: (progress) => {
      log?.(progress);
      onProgress(progress);
    },
  });

  const hasErrors = result.errors.length > 0;
  if (hasErrors) {
    return { ...result, manifest_updated: false, manifest_path: manifestPath };
  }

  const refreshedLocal = await scanCodexHome(cfg.codex_home);
  // A successful apply writes hashes into the manifest. This gives the next
  // device a content-based shared baseline even when its filesystem mtime
  // differs from the source device.
  const forceHashes = cfg.sync?.compare === 'mtime_hash_fallback';
  const transferred = new Set([
    ...(result.uploaded_files ?? []),
    ...(result.downloaded_files ?? []),
  ]);
  const localFiles = forceHashes || state.compareCrossDevice
    ? addLocalHashes(refreshedLocal.allFiles)
    : carryLocalHashes(
      addHashesForPaths(refreshedLocal.allFiles, transferred),
      state.localManifest,
    );
  const localByRel = new Map(localFiles.map((file) => [file.rel, file]));
  const refreshedRemote = userFiles(await dav.list());
  // Reuse hashes fetched during the initial cross-device scan for files that
  // were not transferred. Only the explicit hash comparison mode re-reads
  // every remote body after the apply.
  const observedRemoteBaseline = state.remoteFiles?.length
    ? buildManifest({ remoteFiles: state.remoteFiles })
    : state.baseline;
  const remoteWithKnownHashes = await addRemoteHashes(dav, refreshedRemote, observedRemoteBaseline, {
    localByRel,
    transferred,
    force: forceHashes,
  });
  const manifest = buildManifest({
    machineId: cfg.machine_id,
    localFiles,
    remoteFiles: remoteWithKnownHashes,
  });

  // Update the shared manifest first. A failed remote write must not make a
  // local-only baseline look authoritative on another machine.
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  await dav.putFile(REMOTE_MANIFEST, manifestBuffer);
  try {
    writeManifest(manifestPath, manifest);
  } catch (error) {
    return {
      ...result,
      errors: [...result.errors, {
        action: 'manifest',
        reason: `Remote manifest updated, but local manifest could not be written: ${error.message}`,
      }],
      manifest_updated: false,
      remote_manifest_updated: true,
      manifest_path: manifestPath,
    };
  }

  return {
    ...result,
    manifest_updated: true,
    manifest_path: manifestPath,
  };
}
