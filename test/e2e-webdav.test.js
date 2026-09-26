// test/e2e-webdav.test.js — end-to-end sync against a local WebDAV server
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v2 as webdavServer } from 'webdav-server';
import { createWebDAVClient } from '../src/webdav-client.js';
import { buildPlan, applyPlan } from '../src/sync-engine.js';
import { prepareSync, applySync, REMOTE_MANIFEST } from '../src/sync-service.js';

const PORT = 17999;
let server;
let localDir;

const CONFIG = {
  sync: { compare: 'mtime', time_tolerance_seconds: 2, equal_mtime_action: 'skip' },
  conflict: { policy: 'prefer_newer_mtime' },
  backup: { enabled: false },
};

beforeAll(async () => {
  // anonymous in-memory WebDAV server (auth quirks in webdav-server are not what we test)
  server = new webdavServer.WebDAVServer({ port: PORT });
  await new Promise(res => server.start(() => res()));

  // local test dir with sample session files
  localDir = mkdtempSync(join(tmpdir(), 'cxsync-e2e-'));
  mkdirSync(join(localDir, 'sessions/2026/07/17'), { recursive: true });
  writeFileSync(join(localDir, 'sessions/2026/07/17/rollout-test-1.jsonl'),
    '{"type":"session_meta","payload":{"cwd":"/tmp/proj"}}\n{"type":"message","text":"hello"}\n');
  writeFileSync(join(localDir, 'session_index.jsonl'),
    '{"id":"test-1","thread_name":"e2e test","updated_at":"2026-07-17T00:00:00Z"}\n');
});

afterAll(async () => {
  await new Promise(res => server.stop(() => res()));
  rmSync(localDir, { recursive: true, force: true });
});

function localFileList(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) localFileList(p, base, acc);
    else acc.push({
      rel: p.slice(base.length + 1).replace(/\\/g, '/'),
      absPath: p, mtime: st.mtimeMs, size: st.size,
    });
  }
  return acc;
}

describe('e2e: WebDAV sync', () => {
  const davConfig = {
    url: `http://localhost:${PORT}`,
    remote_path: '/codex-sync',
  };

  test('test connection', async () => {
    const dav = createWebDAVClient(davConfig);
    const r = await dav.testConnection();
    expect(r.ok).toBe(true);
    expect(typeof r.latency_ms).toBe('number');
  });

  test('initial sync uploads all local files', async () => {
    const dav = createWebDAVClient(davConfig);
    const localFiles = localFileList(localDir);
    const remoteFiles = await dav.list().catch(() => []);

    const plan = buildPlan({ localFiles, remoteFiles, config: CONFIG });
    expect(plan.to_upload.length).toBe(2);

    const result = await applyPlan({
      plan, config: CONFIG,
      localBase: localDir,
      remoteBase: '/codex-sync',
      webdavClient: dav,
    });
    expect(result.uploaded).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  test('second sync is a no-op', async () => {
    const dav = createWebDAVClient(davConfig);
    const localFiles = localFileList(localDir);
    const remoteFiles = await dav.list();

    const plan = buildPlan({ localFiles, remoteFiles, config: CONFIG });
    expect(plan.to_upload).toHaveLength(0);
    expect(plan.to_download).toHaveLength(0);
    expect(plan.unchanged.length).toBe(2);
  });

  test('remote file downloads to local', async () => {
    const dav = createWebDAVClient(davConfig);
    // put a new remote file directly (client prefixes remote_path itself)
    await dav.putFile('sessions/2026/07/17/rollout-remote-new.jsonl',
      Buffer.from('{"type":"session_meta","payload":{"cwd":"/other"}}\n'));

    const localFiles = localFileList(localDir);
    const remoteFiles = await dav.list();
    const plan = buildPlan({ localFiles, remoteFiles, config: CONFIG });
    expect(plan.to_download).toContain('sessions/2026/07/17/rollout-remote-new.jsonl');

    const result = await applyPlan({
      plan, config: CONFIG,
      localBase: localDir,
      remoteBase: '/codex-sync',
      webdavClient: dav,
    });
    expect(result.downloaded).toBe(1);
    expect(existsSync(join(localDir, 'sessions/2026/07/17/rollout-remote-new.jsonl'))).toBe(true);
  });

  test('incremental sync persists a baseline and uploads only new files', async () => {
    const incrementalDavConfig = { ...davConfig, remote_path: '/codex-sync-incremental' };
    const dav = createWebDAVClient(incrementalDavConfig);
    const cfg = {
      ...CONFIG,
      codex_home: localDir,
      machine_id: 'e2e-machine',
      manifest_path: join(localDir, '.cxsync-manifest.json'),
      webdav: incrementalDavConfig,
    };

    await dav.putFile('auth.json', Buffer.from('{"token":"must-not-sync"}\n'));
    const initial = await prepareSync(cfg);
    expect(initial.remoteFiles.some((file) => file.rel === 'auth.json')).toBe(false);
    await applySync(initial);
    expect(existsSync(cfg.manifest_path)).toBe(true);
    expect(JSON.parse((await dav.getFile(REMOTE_MANIFEST)).toString()).version).toBe(1);

    mkdirSync(join(localDir, 'skills'), { recursive: true });
    writeFileSync(join(localDir, 'skills/incremental.txt'), 'new file\n');

    const changed = await prepareSync(cfg);
    expect(changed.plan.to_upload).toEqual(['skills/incremental.txt']);
    expect(changed.plan.to_download).toHaveLength(0);
    await applySync(changed);

    const noOp = await prepareSync(cfg);
    expect(noOp.plan.to_upload).toHaveLength(0);
    expect(noOp.plan.to_download).toHaveLength(0);
    expect(noOp.plan.conflicts).toHaveLength(0);
  });
});
