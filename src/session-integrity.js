// src/session-integrity.js - lightweight read-only session consistency checks
import {
  createReadStream,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, extname, isAbsolute, join, relative } from 'node:path';

const ROLLOUT_RE = /^sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-.+\.jsonl$/i;

/**
 * Inspect the local Codex session stores without modifying them.
 *
 * The checker intentionally returns findings instead of throwing for malformed
 * user data. Callers can show warnings in diagnostics while keeping sync's
 * existing cold-sync behavior unchanged.
 *
 * @param {string} codexHome
 * @returns {Promise<{
 *   ok: boolean,
 *   issues: Array<object>,
 *   summary: object,
 *   indexEntries: Array<object>,
 *   rollouts: Array<object>
 * }>}
 */
export async function checkSessionIntegrity(codexHome) {
  const indexPath = join(codexHome, 'session_index.jsonl');
  const index = await readIndex(indexPath);
  const rolloutPaths = findRollouts(codexHome);
  const rollouts = [];
  const issues = [...index.issues];

  for (const absPath of rolloutPaths) {
    const report = await inspectRollout(codexHome, absPath);
    rollouts.push(report);
    issues.push(...report.issues);
  }

  const indexIds = new Set(index.entries.map((entry) => entry.id).filter(Boolean));
  const rolloutIds = new Set(rollouts.map((rollout) => rollout.id).filter(Boolean));

  for (const id of indexIds) {
    if (!rolloutIds.has(id)) {
      issues.push({
        code: 'index_without_rollout',
        severity: 'warning',
        id,
        message: `session_index.jsonl entry has no matching rollout: ${id}`,
      });
    }
  }
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const info = issues.filter((issue) => issue.severity === 'info').length;
  return {
    ok: errors === 0,
    issues,
    summary: {
      index_entries: index.entries.length,
      rollout_files: rollouts.length,
      matched: [...indexIds].filter((id) => rolloutIds.has(id)).length,
      errors,
      warnings,
      info,
    },
    indexEntries: index.entries,
    rollouts,
  };
}

async function readIndex(indexPath) {
  const entries = [];
  const issues = [];
  if (!existsSync(indexPath)) {
    return { entries, issues: [{
      code: 'missing_index',
      severity: 'warning',
      file: 'session_index.jsonl',
      message: 'session_index.jsonl is missing',
    }] };
  }

  const seenIds = new Map();
  const invalidLines = [];
  let lineNumber = 0;
  let lastNonEmptyLine = 0;
  const lines = createInterface({
    input: createReadStream(indexPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    lineNumber++;
    const text = line.trim();
    if (!text) continue;
    lastNonEmptyLine = lineNumber;
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      invalidLines.push(lineNumber);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({
        code: 'invalid_index_entry',
        severity: 'error',
        file: 'session_index.jsonl',
        line: lineNumber,
        message: `session_index.jsonl line ${lineNumber} is not an object`,
      });
      continue;
    }
    if (!entry.id || typeof entry.id !== 'string') {
      issues.push({
        code: 'index_missing_id',
        severity: 'warning',
        file: 'session_index.jsonl',
        line: lineNumber,
        message: `session_index.jsonl line ${lineNumber} has no session id`,
      });
    } else if (seenIds.has(entry.id)) {
      issues.push({
        code: 'duplicate_index_id',
        severity: 'warning',
        id: entry.id,
        file: 'session_index.jsonl',
        line: lineNumber,
        previous_line: seenIds.get(entry.id),
        message: `Duplicate session_index.jsonl id: ${entry.id}`,
      });
    } else {
      seenIds.set(entry.id, lineNumber);
    }
    entries.push(entry);
  }
  for (const line of invalidLines) {
    const truncated = line === lastNonEmptyLine;
    issues.push({
      code: truncated ? 'truncated_index_jsonl' : 'invalid_index_jsonl',
      severity: 'error',
      file: 'session_index.jsonl',
      line,
      message: `${truncated ? 'Possibly truncated' : 'Invalid JSON'} in session_index.jsonl at line ${line}`,
    });
  }
  return { entries, issues };
}

function findRollouts(codexHome) {
  const sessionsDir = join(codexHome, 'sessions');
  const result = [];
  walk(sessionsDir, codexHome, result);
  return result;
}

function walk(dir, base, result) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absPath, base, result);
    } else if (entry.isFile()) {
      const rel = relative(base, absPath).replace(/\\/g, '/');
      if (ROLLOUT_RE.test(rel)) result.push(absPath);
    }
  }
}

async function inspectRollout(codexHome, absPath) {
  const rel = relative(codexHome, absPath).replace(/\\/g, '/');
  let id = rolloutId(absPath, rel);
  const issues = [];
  let size = 0;
  try { size = statSync(absPath).size; } catch {
    issues.push({
      code: 'rollout_unstatable',
      severity: 'error',
      id,
      file: rel,
      message: `Unable to stat rollout: ${rel}`,
    });
    return { id, file: rel, size_bytes: 0, line_count: 0, cwd: null, issues };
  }

  if (size === 0) {
    issues.push({
      code: 'empty_rollout',
      severity: 'error',
      id,
      file: rel,
      message: `Rollout is empty: ${rel}`,
    });
    return { id, file: rel, size_bytes: size, line_count: 0, cwd: null, issues };
  }

  let firstLine;
  let lastLine;
  try {
    const fd = openSync(absPath, 'r');
    try {
      firstLine = readBoundaryLine(fd, size, 'first');
      lastLine = readBoundaryLine(fd, size, 'last');
    } finally { closeSync(fd); }
  } catch (error) {
    issues.push({
      code: 'rollout_read_error',
      severity: 'error',
      id,
      file: rel,
      message: `Unable to read rollout: ${rel} (${error.message})`,
    });
  }

  const firstValue = parseJsonLine(firstLine?.text);
  if (!firstLine?.text || !firstValue) {
    issues.push({
      code: firstLine?.complete === false ? 'large_first_record' : 'invalid_jsonl',
      severity: firstLine?.complete === false ? 'warning' : 'error',
      id,
      file: rel,
      line: 1,
      message: `Invalid first JSONL record: ${rel}:1`,
    });
  }
  const lastValue = parseJsonLine(lastLine?.text);
  if (lastLine?.text && !lastValue) {
    issues.push({
      code: lastLine.complete === false ? 'large_final_record' : 'truncated_jsonl',
      severity: lastLine.complete === false ? 'warning' : 'error',
      id,
      file: rel,
      message: `Possibly truncated final JSONL record: ${rel}`,
    });
  }

  const metaId = firstValue?.payload?.id || firstValue?.id;
  if (typeof metaId === 'string' && metaId) id = metaId;
  const cwd = extractCwd(firstValue);
  if (!firstValue || firstValue.type !== 'session_meta') {
    issues.push({
      code: 'missing_session_meta',
      severity: 'info',
      id,
      file: rel,
      message: `First rollout record is not session_meta: ${rel}`,
    });
  }
  if (cwd && isAbsoluteCwd(cwd)) {
    issues.push({
      code: 'absolute_cwd',
      severity: 'info',
      id,
      file: rel,
      cwd,
      message: `Session cwd is absolute and may differ on another machine: ${cwd}`,
    });
  }

  return { id, file: rel, size_bytes: size, cwd, issues };
}

function readBoundaryLine(fd, size, edge, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  let position = edge === 'first' ? 0 : size;
  while (bytes < Math.min(size, limit)) {
    const length = Math.min(64 * 1024, limit - bytes, edge === 'first' ? size - position : position);
    if (length <= 0) break;
    position = edge === 'first' ? position : position - length;
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (!count) break;
    bytes += count;
    chunks.push(edge === 'first' ? chunk.subarray(0, count) : Buffer.from(chunk.subarray(0, count)));

    const text = Buffer.concat(edge === 'first' ? chunks : [...chunks].reverse()).toString('utf8');
    const content = edge === 'last' ? text.replace(/[\r\n]+$/, '') : text;
    const boundary = edge === 'first' ? content.indexOf('\n') : content.lastIndexOf('\n');
    if (boundary >= 0) {
      const line = edge === 'first' ? content.slice(0, boundary) : content.slice(boundary + 1);
      const normalized = line.trim();
      if (normalized) return { text: normalized, complete: true };
    }
    if (edge === 'first' && position + count >= size) break;
  }

  const text = Buffer.concat(edge === 'first' ? chunks : [...chunks].reverse()).toString('utf8');
  const normalized = text.trim();
  return { text: normalized, complete: bytes >= size };
}

function parseJsonLine(line) {
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function rolloutId(absPath, relPath) {
  const name = basename(absPath, extname(absPath));
  const uuid = name.match(/^rollout-.+?-([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  if (uuid) return uuid[1];
  // Keep this in lockstep with scanner.js: non-UUID rollout names use the
  // normalized path as their fallback identifier.
  return relPath.replace(/\.jsonl$/i, '');
}

function extractCwd(firstValue) {
  if (!firstValue || typeof firstValue !== 'object') return null;
  return firstValue.payload?.cwd || firstValue.cwd || firstValue.workdir || null;
}

function isAbsoluteCwd(cwd) {
  return typeof cwd === 'string' && (isAbsolute(cwd) || /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\/.test(cwd));
}
