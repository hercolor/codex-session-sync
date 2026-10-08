import { describe, expect, test } from '@jest/globals';
import { configForClient, validateConfig } from '../src/config.js';

describe('configForClient', () => {
  const config = {
    codex_home: '/home/example/.codex',
    claude_home: '/home/example/.claude',
    manifest_path: '/tmp/codex-manifest.json',
    claude_manifest_path: '/tmp/claude-manifest.json',
    webdav: { url: 'https://example.test/dav', remote_path: '/codex-sync/' },
  };

  test('keeps Codex as the default without changing the original config', () => {
    const selected = configForClient(config);
    expect(selected.local_home).toBe(config.codex_home);
    expect(selected.manifest_path).toBe(config.manifest_path);
    expect(selected.webdav.remote_path).toBe('/codex-sync/');
    expect(config.sync_client).toBeUndefined();
  });

  test('isolates Claude home, manifest, and WebDAV repository', () => {
    const selected = configForClient(config, 'claude');
    expect(selected.local_home).toBe(config.claude_home);
    expect(selected.manifest_path).toBe(config.claude_manifest_path);
    expect(selected.webdav.remote_path).toBe('/codex-sync-claude');
    expect(config.webdav.remote_path).toBe('/codex-sync/');
  });

  test('accepts a custom Claude remote path but rejects collisions', () => {
    expect(configForClient({ ...config, claude_remote_path: '/separate-claude' }, 'claude')
      .webdav.remote_path).toBe('/separate-claude');
    expect(() => configForClient({ ...config, claude_remote_path: '/codex-sync' }, 'claude'))
      .toThrow('must differ');
    expect(() => configForClient(config, 'unknown')).toThrow('Unknown sync client');
  });

  test('rejects WebDAV paths that may resolve to the same repository', () => {
    const unsafe = { ...config, claude_remote_path: '/other/../codex-sync' };
    expect(() => configForClient(unsafe, 'claude')).toThrow('unsafe path segments');
    expect(validateConfig(unsafe)).toContain('claude_remote_path contains unsafe path segments');
    expect(() => configForClient({
      ...config,
      webdav: { ...config.webdav, remote_path: '/codex-sync/../other' },
    })).toThrow('unsafe path segments');
    expect(() => configForClient({ ...config, claude_remote_path: '/codex-sync//' }, 'claude'))
      .toThrow('must differ');
  });
});
