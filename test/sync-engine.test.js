// test/sync-engine.test.js
import { describe, test, expect } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyPlan, atomicWriteFileSync, buildPlan } from '../src/sync-engine.js';

const BASE_CONFIG = {
  sync: { compare: 'mtime', time_tolerance_seconds: 2, equal_mtime_action: 'skip' },
  conflict: { policy: 'manual_abort' },
};

// helper: file entry
const f = (mtime, size = 100) => ({ mtime, size });

describe('buildPlan', () => {
  test('upload new local file', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/a.jsonl': f(1000) },
      remoteFiles: {},
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('sessions/a.jsonl');
    expect(plan.to_download).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test('download new remote file', () => {
    const plan = buildPlan({
      localFiles:  {},
      remoteFiles: { 'sessions/b.jsonl': f(2000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_download).toContain('sessions/b.jsonl');
    expect(plan.to_upload).toHaveLength(0);
  });

  test('unchanged file (same mtime+size)', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/c.jsonl': f(1000, 200) },
      remoteFiles: { 'sessions/c.jsonl': f(1000, 200) },
      config: BASE_CONFIG,
    });
    expect(plan.unchanged).toContain('sessions/c.jsonl');
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
  });

  test('known hashes detect different content with matching mtime and size', () => {
    const plan = buildPlan({
      localFiles: { 'sessions/a.jsonl': { mtime: 1000, size: 100, sha256: 'local' } },
      remoteFiles: { 'sessions/a.jsonl': { mtime: 1000, size: 100, sha256: 'remote' } },
      config: BASE_CONFIG,
    });
    expect(plan.conflicts.map((item) => item.rel)).toEqual(['sessions/a.jsonl']);
  });

  test('matching hashes override different endpoint mtimes', () => {
    const plan = buildPlan({
      localFiles: { 'sessions/a.jsonl': { mtime: 1000, size: 100, sha256: 'same' } },
      remoteFiles: { 'sessions/a.jsonl': { mtime: 10000, size: 100, sha256: 'same' } },
      config: BASE_CONFIG,
    });
    expect(plan.unchanged).toEqual(['sessions/a.jsonl']);
  });

  test('local newer → upload', () => {
    // diff = 10000ms > tolerance 2000ms → should upload
    const plan = buildPlan({
      localFiles:  { 'sessions/d.jsonl': f(20000) },
      remoteFiles: { 'sessions/d.jsonl': f(10000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('sessions/d.jsonl');
  });

  test('remote newer → download', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/e.jsonl': f(1000) },
      remoteFiles: { 'sessions/e.jsonl': f(9000) },
      config: BASE_CONFIG,
    });
    expect(plan.to_download).toContain('sessions/e.jsonl');
  });

  test('within tolerance → unchanged (equal_mtime_action=skip)', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/f.jsonl': f(1000) },
      remoteFiles: { 'sessions/f.jsonl': f(1001) }, // 1ms diff, tolerance 2s
      config: BASE_CONFIG,
    });
    expect(plan.unchanged).toContain('sessions/f.jsonl');
  });

  test('conflict: both sides changed, policy=manual_abort', () => {
    // simulate both sides different size at similar mtime
    const plan = buildPlan({
      localFiles:  { 'session_index.jsonl': { mtime: 5000, size: 300 } },
      remoteFiles: { 'session_index.jsonl': { mtime: 5000, size: 999 } },
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, equal_mtime_action: 'manual_abort' } },
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });

  test('multiple files mixed', () => {
    // Use mtime values clearly beyond 2000ms tolerance
    const plan = buildPlan({
      localFiles: {
        'a.jsonl': f(100000),
        'b.jsonl': f(200000),
        'c.jsonl': f(300000), // local mtime >> remote
      },
      remoteFiles: {
        'b.jsonl': f(200000),
        'c.jsonl': f(100000), // remote much older → local should upload
        'd.jsonl': f(400000), // only remote
      },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toContain('a.jsonl');
    expect(plan.to_upload).toContain('c.jsonl');
    expect(plan.to_download).toContain('d.jsonl');
    expect(plan.unchanged).toContain('b.jsonl');
  });

  test('baseline: only local change uploads', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/a.jsonl': f(3000, 120) },
      remoteFiles: { 'sessions/a.jsonl': f(1000, 100) },
      baseline: {
        files: {
          'sessions/a.jsonl': {
            local: f(1000, 100),
            remote: f(1000, 100),
          },
        },
      },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toEqual(['sessions/a.jsonl']);
    expect(plan.to_download).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test('baseline: both sides changed becomes a conflict', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/a.jsonl': f(3000, 120) },
      remoteFiles: { 'sessions/a.jsonl': f(4000, 130) },
      baseline: {
        files: {
          'sessions/a.jsonl': {
            local: f(1000, 100),
            remote: f(1000, 100),
          },
        },
      },
      config: BASE_CONFIG,
    });
    expect(plan.conflicts.map(c => c.rel)).toEqual(['sessions/a.jsonl']);
  });

  test('baseline hashes survive different endpoint mtimes', () => {
    const plan = buildPlan({
      localFiles:  { 'sessions/a.jsonl': { mtime: 9000, size: 100, sha256: 'same' } },
      remoteFiles: { 'sessions/a.jsonl': { mtime: 10000, size: 100, sha256: 'same' } },
      baseline: {
        files: {
          'sessions/a.jsonl': {
            local: { mtime: 1000, size: 100, sha256: 'same' },
            remote: { mtime: 2000, size: 100, sha256: 'same' },
          },
        },
      },
      config: BASE_CONFIG,
    });
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
    expect(plan.unchanged).toEqual(['sessions/a.jsonl']);
  });

  test('direction push suppresses downloads and resolves conflicts locally', () => {
    const config = { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'push' } };
    const plan = buildPlan({
      localFiles:  {
        'sessions/local.jsonl': f(3000),
        'sessions/shared.jsonl': f(3000, 120),
      },
      remoteFiles: { 'sessions/remote.jsonl': f(1000), 'sessions/shared.jsonl': f(3000, 120) },
      baseline: {
        files: {
          'sessions/shared.jsonl': { local: f(1000, 100), remote: f(1000, 100) },
        },
      },
      config,
    });
    expect(plan.to_upload).toEqual(expect.arrayContaining(['sessions/local.jsonl', 'sessions/shared.jsonl']));
    expect(plan.to_download).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test('direction pull suppresses uploads and resolves conflicts from cloud', () => {
    const config = { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'pull' } };
    const plan = buildPlan({
      localFiles:  { 'sessions/local.jsonl': f(3000) },
      remoteFiles: { 'sessions/remote.jsonl': f(1000), 'sessions/shared.jsonl': f(3000, 120) },
      baseline: {
        files: {
          'sessions/shared.jsonl': { local: f(1000, 100), remote: f(1000, 100) },
        },
      },
      config,
    });
    expect(plan.to_download).toEqual(expect.arrayContaining(['sessions/remote.jsonl', 'sessions/shared.jsonl']));
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test('one-way sync leaves changed destination-only files untouched', () => {
    const baseline = {
      files: {
        'remote-only.jsonl': { local: null, remote: f(1000, 100) },
        'local-only.jsonl': { local: f(1000, 100), remote: null },
      },
    };
    const push = buildPlan({
      localFiles: {},
      remoteFiles: { 'remote-only.jsonl': f(3000, 120) },
      baseline,
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'push' } },
    });
    expect(push.to_upload).toHaveLength(0);
    expect(push.unchanged).toContain('remote-only.jsonl');

    const pull = buildPlan({
      localFiles: { 'local-only.jsonl': f(3000, 120) },
      remoteFiles: {},
      baseline,
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'pull' } },
    });
    expect(pull.to_download).toHaveLength(0);
    expect(pull.unchanged).toContain('local-only.jsonl');
  });

  test('pull treats remote content as authoritative on a first device run', () => {
    const config = { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'pull' } };
    const plan = buildPlan({
      localFiles: { 'sessions/a.jsonl': f(9000, 100) },
      remoteFiles: { 'sessions/a.jsonl': f(1000, 100) },
      config,
    });
    expect(plan.to_download).toEqual(['sessions/a.jsonl']);
    expect(plan.to_upload).toHaveLength(0);
  });

  test('push and pull use known hashes to resolve same-metadata differences', () => {
    const localFiles = { 'sessions/a.jsonl': { mtime: 1000, size: 100, sha256: 'local' } };
    const remoteFiles = { 'sessions/a.jsonl': { mtime: 1000, size: 100, sha256: 'remote' } };
    const push = buildPlan({
      localFiles,
      remoteFiles,
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'push' } },
    });
    const pull = buildPlan({
      localFiles,
      remoteFiles,
      config: { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'pull' } },
    });
    expect(push.to_upload).toEqual(['sessions/a.jsonl']);
    expect(pull.to_download).toEqual(['sessions/a.jsonl']);
  });

  test('bidirectional hash differences stay conflicts even when one mtime is newer', () => {
    const plan = buildPlan({
      localFiles: { 'sessions/a.jsonl': { mtime: 10000, size: 100, sha256: 'local' } },
      remoteFiles: { 'sessions/a.jsonl': { mtime: 1000, size: 100, sha256: 'remote' } },
      config: BASE_CONFIG,
    });
    expect(plan.conflicts.map((item) => item.rel)).toEqual(['sessions/a.jsonl']);
  });

  test('local manifest wins over another device remote mtime baseline', () => {
    const config = { ...BASE_CONFIG, sync: { ...BASE_CONFIG.sync, direction: 'pull' } };
    const plan = buildPlan({
      localFiles: { 'sessions/a.jsonl': { mtime: 9000, size: 100, sha256: 'same' } },
      remoteFiles: { 'sessions/a.jsonl': { mtime: 1000, size: 100, sha256: 'same' } },
      baseline: {
        files: {
          'sessions/a.jsonl': {
            local: { mtime: 9000, size: 100, sha256: 'same' },
            remote: { mtime: 1000, size: 100, sha256: 'same' },
          },
        },
      },
      config,
    });
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
  });
});

describe('applyPlan', () => {
  test('rejects unsafe relative paths before local or WebDAV I/O', async () => {
    const localBase = mkdtempSync(join(tmpdir(), 'cxsync-unsafe-path-'));
    let getCalls = 0;
    let putCalls = 0;
    const webdavClient = {
      async getFile() { getCalls++; return Buffer.from('remote'); },
      async putFile() { putCalls++; },
    };

    try {
      const result = await applyPlan({
        plan: {
          to_upload: ['../outside-upload.txt'],
          to_download: ['/outside-download.txt'],
          conflicts: [],
          unchanged: [],
        },
        config: { backup: { enabled: true }, backup_dir: join(localBase, 'backups') },
        localBase,
        remoteBase: '/sync',
        webdavClient,
      });

      expect(result.uploaded).toBe(0);
      expect(result.downloaded).toBe(0);
      expect(result.errors).toHaveLength(2);
      expect(result.errors.every((error) => /Unsafe relative path/.test(error.reason))).toBe(true);
      expect(getCalls).toBe(0);
      expect(putCalls).toBe(0);
      expect(existsSync(join(localBase, 'outside-download.txt'))).toBe(false);
    } finally {
      rmSync(localBase, { recursive: true, force: true });
    }
  });

  test('persists a remote overwrite backup before uploading', async () => {
    const localBase = mkdtempSync(join(tmpdir(), 'cxsync-backup-home-'));
    const backupDir = mkdtempSync(join(tmpdir(), 'cxsync-backup-state-'));
    const rel = 'sessions/overwrite.jsonl';
    const localPath = join(localBase, rel);
    mkdirSync(join(localBase, 'sessions'), { recursive: true });
    writeFileSync(localPath, 'new remote content');
    let uploaded;
    const webdavClient = {
      async getFile(path) {
        expect(path).toBe(rel);
        return Buffer.from('old remote content');
      },
      async putFile(path, data) {
        uploaded = { path, data: Buffer.from(data).toString('utf8') };
      },
    };

    try {
      const result = await applyPlan({
        plan: { to_upload: [rel], to_download: [], conflicts: [], unchanged: [] },
        config: { backup: { enabled: true }, backup_dir: backupDir },
        localBase,
        remoteBase: '/sync',
        webdavClient,
      });

      expect(result.errors).toHaveLength(0);
      expect(result.uploaded).toBe(1);
      expect(uploaded).toEqual({ path: rel, data: 'new remote content' });
      const runs = readdirSync(join(backupDir, '.remote-overwrites'));
      expect(runs).toHaveLength(1);
      expect(readFileSync(join(backupDir, '.remote-overwrites', runs[0], rel), 'utf8'))
        .toBe('old remote content');
    } finally {
      rmSync(localBase, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  test('downloads through a same-directory temporary file and replaces the destination', async () => {
    const localBase = mkdtempSync(join(tmpdir(), 'cxsync-atomic-download-'));
    const rel = 'sessions/atomic.jsonl';
    const localPath = join(localBase, rel);
    mkdirSync(join(localBase, 'sessions'), { recursive: true });
    writeFileSync(localPath, 'old complete content');

    try {
      const result = await applyPlan({
        plan: { to_upload: [], to_download: [rel], conflicts: [], unchanged: [] },
        config: { backup: { enabled: false } },
        localBase,
        remoteBase: '/sync',
        webdavClient: { async getFile() { return Buffer.from('new complete content'); } },
      });

      expect(result.errors).toHaveLength(0);
      expect(readFileSync(localPath, 'utf8')).toBe('new complete content');
      expect(readdirSync(join(localBase, 'sessions'))).toEqual(['atomic.jsonl']);
    } finally {
      rmSync(localBase, { recursive: true, force: true });
    }
  });

  test('keeps the existing file when atomic replacement fails', async () => {
    const localBase = mkdtempSync(join(tmpdir(), 'cxsync-atomic-failure-'));
    const rel = 'sessions/kept.jsonl';
    const localPath = join(localBase, rel);
    mkdirSync(join(localBase, 'sessions'), { recursive: true });
    writeFileSync(localPath, 'old complete content');

    try {
      const result = await applyPlan({
        plan: { to_upload: [], to_download: [rel], conflicts: [], unchanged: [] },
        config: { backup: { enabled: false } },
        localBase,
        remoteBase: '/sync',
        webdavClient: { async getFile() { return Buffer.from('new content'); } },
        writeLocalFile(path, data) {
          atomicWriteFileSync(path, data, {
            write() { throw new Error('simulated disk write failure'); },
          });
        },
      });

      expect(result.errors).toHaveLength(1);
      expect(readFileSync(localPath, 'utf8')).toBe('old complete content');
    } finally {
      rmSync(localBase, { recursive: true, force: true });
    }
  });

  test('does not follow a local symbolic link while downloading', async () => {
    const localBase = mkdtempSync(join(tmpdir(), 'cxsync-linked-home-'));
    const outside = mkdtempSync(join(tmpdir(), 'cxsync-linked-outside-'));
    const rel = 'projects/-tmp-project/memory/MEMORY.md';
    mkdirSync(join(localBase, 'projects'), { recursive: true });
    symlinkSync(outside, join(localBase, 'projects/-tmp-project'));

    try {
      const result = await applyPlan({
        plan: { to_upload: [], to_download: [rel], conflicts: [], unchanged: [] },
        config: { backup: { enabled: false } },
        localBase,
        remoteBase: '/sync',
        webdavClient: { async getFile() { return Buffer.from('remote memory'); } },
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toMatch(/symbolic link/);
      expect(existsSync(join(outside, 'memory/MEMORY.md'))).toBe(false);
    } finally {
      rmSync(localBase, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('does not follow a symbolic link used as the local root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cxsync-linked-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'cxsync-linked-outside-'));
    const localBase = join(parent, 'claude');
    const rel = 'projects/-tmp-project/memory/MEMORY.md';
    symlinkSync(outside, localBase);

    try {
      const result = await applyPlan({
        plan: { to_upload: [], to_download: [rel], conflicts: [], unchanged: [] },
        config: { backup: { enabled: false } },
        localBase,
        remoteBase: '/sync',
        webdavClient: { async getFile() { return Buffer.from('remote memory'); } },
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toMatch(/symbolic link/);
      expect(existsSync(join(outside, rel))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
