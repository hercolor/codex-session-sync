// test/e2e-webdav.test.js — end-to-end sync against a local WebDAV server
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v2 as webdavServer } from 'webdav-server';
import { createWebDAVClient } from '../src/webdav-client.js';
import { configForClient } from '../src/config.js';
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

  test('two devices merge new sessions and index entries through WebDAV', async () => {
    const remoteConfig = { ...davConfig, remote_path: '/codex-sync-two-devices' };
    const deviceA = mkdtempSync(join(tmpdir(), 'cxsync-device-a-'));
    const deviceB = mkdtempSync(join(tmpdir(), 'cxsync-device-b-'));
    const makeConfig = (home, machineId) => ({
      ...CONFIG,
      codex_home: home,
      machine_id: machineId,
      manifest_path: join(home, '.cxsync-state', 'manifest.json'),
      webdav: remoteConfig,
    });
    const cfgA = makeConfig(deviceA, 'device-a');
    const cfgB = makeConfig(deviceB, 'device-b');
    const idA = 'e2e-device-a-session';
    const idB = 'e2e-device-b-session';
    const rolloutA = 'sessions/2026/09/28/rollout-device-a.jsonl';
    const rolloutB = 'sessions/2026/09/28/rollout-device-b.jsonl';

    try {
      // Establish independent empty baselines for both devices.
      await applySync(await prepareSync(cfgA));
      await applySync(await prepareSync(cfgB));

      for (const home of [deviceA, deviceB]) mkdirSync(join(home, 'sessions/2026/09/28'), { recursive: true });
      writeFileSync(join(deviceA, rolloutA), '{"type":"session_meta","payload":{"cwd":"/tmp/a"}}\n');
      writeFileSync(join(deviceB, rolloutB), '{"type":"session_meta","payload":{"cwd":"/tmp/b"}}\n');
      writeFileSync(join(deviceA, 'session_index.jsonl'), `${JSON.stringify({ id: idA, thread_name: 'device A', updated_at: '2026-09-28T01:00:00Z' })}\n`);
      writeFileSync(join(deviceB, 'session_index.jsonl'), `${JSON.stringify({ id: idB, thread_name: 'device B', updated_at: '2026-09-28T02:00:00Z' })}\n`);

      await applySync(await prepareSync(cfgA));
      const deviceBPlan = await prepareSync(cfgB);
      expect(deviceBPlan.plan.conflicts).toHaveLength(0);
      expect(deviceBPlan.plan.to_upload).toContain('session_index.jsonl');
      expect(deviceBPlan.plan.to_download).toContain('session_index.jsonl');
      await applySync(deviceBPlan);
      await applySync(await prepareSync(cfgA));

      for (const home of [deviceA, deviceB]) {
        const entries = readFileSync(join(home, 'session_index.jsonl'), 'utf8')
          .trim().split('\n').map((line) => JSON.parse(line));
        expect(entries.map((entry) => entry.id).sort()).toEqual([idA, idB].sort());
        expect(existsSync(join(home, rolloutA))).toBe(true);
        expect(existsSync(join(home, rolloutB))).toBe(true);
      }

      const dav = createWebDAVClient(remoteConfig);
      const remoteEntries = (await dav.getFile('session_index.jsonl')).toString('utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      expect(remoteEntries.map((entry) => entry.id).sort()).toEqual([idA, idB].sort());
    } finally {
      rmSync(deviceA, { recursive: true, force: true });
      rmSync(deviceB, { recursive: true, force: true });
    }
  });

  test('Claude Code sessions, subagents, tool results and memory sync between devices in a separate repository', async () => {
    const baseRemote = '/codex-sync-with-claude';
    const deviceA = mkdtempSync(join(tmpdir(), 'cxsync-claude-a-'));
    const deviceB = mkdtempSync(join(tmpdir(), 'cxsync-claude-b-'));
    const idA = '019f1b39-1111-4111-8111-019f1b391111';
    const idB = '019f1b39-2222-4222-8222-019f1b392222';
    const project = 'projects/-work-same-project';
    const sessionA = `${project}/${idA}.jsonl`;
    const sessionB = `${project}/${idB}.jsonl`;
    const baseConfig = (home, machineId) => ({
      ...CONFIG,
      codex_home: join(home, 'codex'),
      claude_home: join(home, 'claude'),
      claude_manifest_path: join(home, 'claude-manifest.json'),
      machine_id: machineId,
      webdav: { ...davConfig, remote_path: baseRemote },
    });
    const cfgA = configForClient(baseConfig(deviceA, 'claude-a'), 'claude');
    const cfgB = configForClient(baseConfig(deviceB, 'claude-b'), 'claude');
    const claudeDav = createWebDAVClient(cfgA.webdav);
    const codexDav = createWebDAVClient({ ...davConfig, remote_path: baseRemote });
    const putLocal = (home, rel, text) => {
      const path = join(home, rel);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    };

    try {
      expect(cfgA.webdav.remote_path).toBe(`${baseRemote}-claude`);
      putLocal(cfgA.local_home, sessionA, '{"type":"user","message":"first"}\n');
      putLocal(cfgA.local_home, `${project}/${idA}/subagents/agent-1.jsonl`, '{"type":"assistant"}\n');
      putLocal(cfgA.local_home, `${project}/${idA}/tool-results/result.txt`, 'tool output\n');
      putLocal(cfgA.local_home, `${project}/memory/MEMORY.md`, 'project memory\n');
      putLocal(cfgA.local_home, '.credentials.json', '{"token":"not-synced"}');
      putLocal(cfgA.local_home, 'settings.json', '{"apiKey":"not-synced"}');
      putLocal(cfgA.local_home, 'sessions/process.key', 'not-synced');

      const initial = await prepareSync(cfgA);
      expect(initial.plan.to_upload).toEqual(expect.arrayContaining([
        sessionA,
        `${project}/${idA}/subagents/agent-1.jsonl`,
        `${project}/${idA}/tool-results/result.txt`,
        `${project}/memory/MEMORY.md`,
      ]));
      expect(initial.plan.to_upload).toHaveLength(4);
      expect((await applySync(initial)).errors).toHaveLength(0);

      const firstPull = await prepareSync(cfgB);
      expect(firstPull.plan.to_download).toHaveLength(4);
      expect((await applySync(firstPull)).errors).toHaveLength(0);
      expect(readFileSync(join(cfgB.local_home, sessionA), 'utf8')).toContain('first');
      expect(existsSync(join(cfgB.local_home, '.credentials.json'))).toBe(false);

      putLocal(cfgB.local_home, sessionB, '{"type":"user","message":"second"}\n');
      expect((await applySync(await prepareSync(cfgB))).errors).toHaveLength(0);
      expect((await applySync(await prepareSync(cfgA))).errors).toHaveLength(0);
      expect(readFileSync(join(cfgA.local_home, sessionB), 'utf8')).toContain('second');
      expect((await claudeDav.list()).map((file) => file.rel)).toEqual(expect.arrayContaining([
        REMOTE_MANIFEST, sessionA, sessionB,
      ]));
      expect((await codexDav.list())).toHaveLength(0);
      expect(existsSync(cfgA.manifest_path)).toBe(true);
      expect(existsSync(cfgB.manifest_path)).toBe(true);
    } finally {
      rmSync(deviceA, { recursive: true, force: true });
      rmSync(deviceB, { recursive: true, force: true });
    }
  });

  test('Claude Code reports a conflict when both devices modify the same transcript', async () => {
    const deviceA = mkdtempSync(join(tmpdir(), 'cxsync-claude-conflict-a-'));
    const deviceB = mkdtempSync(join(tmpdir(), 'cxsync-claude-conflict-b-'));
    const remotePath = '/codex-sync-claude-conflict';
    const session = 'projects/-work-project/019f1b39-3333-4333-8333-019f1b393333.jsonl';
    const config = (home, machineId) => configForClient({
      ...CONFIG,
      claude_home: join(home, 'claude'),
      claude_manifest_path: join(home, 'manifest.json'),
      machine_id: machineId,
      webdav: { ...davConfig, remote_path: remotePath },
      conflict: { policy: 'manual_abort' },
    }, 'claude');
    const cfgA = config(deviceA, 'conflict-a');
    const cfgB = config(deviceB, 'conflict-b');

    try {
      mkdirSync(join(cfgA.local_home, 'projects/-work-project'), { recursive: true });
      writeFileSync(join(cfgA.local_home, session), 'original transcript\n');
      expect((await applySync(await prepareSync(cfgA))).errors).toHaveLength(0);
      expect((await applySync(await prepareSync(cfgB))).errors).toHaveLength(0);

      writeFileSync(join(cfgA.local_home, session), 'device A extended transcript\n');
      writeFileSync(join(cfgB.local_home, session), 'device B different extended transcript\n');
      expect((await applySync(await prepareSync(cfgA))).errors).toHaveLength(0);

      const pending = await prepareSync(cfgB);
      expect(pending.plan.conflicts.map((entry) => entry.rel)).toContain(session);
      const result = await applySync(pending);
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ rel: session, reason: 'conflict' })]));
      expect(result.manifest_updated).toBe(false);
      expect(readFileSync(join(cfgB.local_home, session), 'utf8')).toContain('device B');
    } finally {
      rmSync(deviceA, { recursive: true, force: true });
      rmSync(deviceB, { recursive: true, force: true });
    }
  });

  test.each([
    ['push', 'remote'],
    ['pull', 'local'],
  ])('%s treats its selected index as authoritative even if the other index is malformed', async (direction, malformedSide) => {
    const remoteConfig = { ...davConfig, remote_path: `/codex-sync-index-${direction}` };
    const dav = createWebDAVClient(remoteConfig);
    const home = mkdtempSync(join(tmpdir(), `cxsync-index-${direction}-`));
    const validIndex = `${JSON.stringify({ id: `valid-${direction}`, updated_at: '2026-09-28T00:00:00Z' })}\n`;
    const malformedIndex = '{"id":"broken"\n';
    const localIndex = malformedSide === 'local' ? malformedIndex : validIndex;
    const remoteIndex = malformedSide === 'remote' ? malformedIndex : validIndex;
    const cfg = {
      ...CONFIG,
      codex_home: home,
      machine_id: `machine-${direction}`,
      manifest_path: join(home, '.cxsync-state', 'manifest.json'),
      webdav: remoteConfig,
      sync: { ...CONFIG.sync, direction },
    };

    try {
      writeFileSync(join(home, 'session_index.jsonl'), localIndex);
      await dav.putFile('session_index.jsonl', Buffer.from(remoteIndex));
      const result = await applySync(await prepareSync(cfg));

      expect(result.errors).toHaveLength(0);
      const expected = direction === 'push' ? localIndex : remoteIndex;
      expect(readFileSync(join(home, 'session_index.jsonl'), 'utf8')).toBe(expected);
      expect((await dav.getFile('session_index.jsonl')).toString('utf8')).toBe(expected);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
