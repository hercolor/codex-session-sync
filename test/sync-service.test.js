// test/sync-service.test.js
import { describe, test, expect } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySync } from '../src/sync-service.js';

describe('sync service', () => {
  test('preserves a remote hash fetched during a first cross-device scan', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'cxsync-service-home-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'cxsync-service-state-'));
    const rel = 'sessions/2026/01/01/rollout-cross-device.jsonl';
    const localPath = join(codexHome, rel);
    mkdirSync(join(codexHome, 'sessions/2026/01/01'), { recursive: true });
    writeFileSync(localPath, '{"type":"session_meta","payload":{"cwd":"/tmp/project"}}\n');
    const mtime = statSync(localPath).mtimeMs;
    const size = statSync(localPath).size;
    const remoteManifestWrites = [];
    const dav = {
      async list() {
        return [{ rel, mtime, size }];
      },
      async putFile(path, data) {
        if (path === '.cxsync-manifest.json') {
          remoteManifestWrites.push(JSON.parse(Buffer.from(data).toString('utf8')));
        }
      },
    };

    try {
      const result = await applySync({
        cfg: {
          codex_home: codexHome,
          machine_id: 'cross-device-test',
          manifest_path: join(stateDir, 'manifest.json'),
          webdav: { remote_path: '/codex-sync' },
          sync: { compare: 'mtime' },
          backup: { enabled: false },
        },
        dav,
        manifestPath: join(stateDir, 'manifest.json'),
        localManifest: null,
        baseline: null,
        compareCrossDevice: true,
        remoteFiles: [{ rel, mtime, size, sha256: 'fetched-before-apply' }],
        plan: { to_upload: [], to_download: [], conflicts: [], unchanged: [rel] },
      });

      expect(result.errors).toHaveLength(0);
      expect(result.manifest_updated).toBe(true);
      expect(remoteManifestWrites).toHaveLength(1);
      expect(remoteManifestWrites[0].files[rel].remote.sha256)
        .toBe('fetched-before-apply');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
