// test/manifest.test.js
import { describe, test, expect } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  MANIFEST_VERSION,
  buildManifest,
  getManifestPath,
  normalizeManifest,
  readManifest,
  writeManifest,
} from '../src/manifest.js';

describe('sync manifest', () => {
  test('builds a versioned side-specific baseline', () => {
    const manifest = buildManifest({
      machineId: 'machine-a',
      localFiles: [{ rel: 'a.jsonl', mtime: 10, size: 2 }],
      remoteFiles: [{ rel: 'a.jsonl', mtime: 20, size: 2 }],
    });

    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.machine_id).toBe('machine-a');
    expect(manifest.files['a.jsonl']).toEqual({
      local: { mtime: 10, size: 2 },
      remote: { mtime: 20, size: 2 },
    });
  });

  test('writes atomically and reads a normalized manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cxsync-manifest-'));
    const path = join(dir, 'manifest.json');
    const input = buildManifest({ localFiles: [], remoteFiles: [] });

    try {
      writeManifest(path, input);
      expect(readManifest(path)).toEqual(input);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts legacy flat entries and rejects unsupported versions', () => {
    expect(normalizeManifest({ files: { 'a.jsonl': { mtime: 1, size: 2 } } }).files['a.jsonl'])
      .toEqual({ mtime: 1, size: 2 });
    expect(normalizeManifest({ version: MANIFEST_VERSION + 1, files: {} })).toBeNull();
    expect(normalizeManifest({ files: { '../outside': { mtime: 1, size: 2 } } })).toBeNull();
    expect(normalizeManifest({ files: { 'C:/outside': { mtime: 1, size: 2 } } })).toBeNull();
  });

  test('derives a manifest path outside codex_home', () => {
    expect(getManifestPath({ backup_dir: '/tmp/cxsync/backups' }))
      .toBe('/tmp/cxsync/manifest.json');
    expect(getManifestPath({ config: { manifest_path: '/tmp/cxsync/state.json' } }))
      .toBe('/tmp/cxsync/state.json');
  });
});
