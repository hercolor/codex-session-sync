import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';
import { loadConfig, mergeConfig, saveConfig, validateConfig } from '../src/config.js';

describe('config persistence', () => {
  let directory;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cxsync-config-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('creates a private config that can be loaded by the next CLI invocation', () => {
    const configPath = join(directory, 'private', 'config.yml');
    const updates = { webdav: { url: 'https://example.test/dav', username: 'alice', password: 'secret' } };
    saveConfig(configPath, updates);

    const cfg = loadConfig(configPath);
    expect(cfg.webdav).toEqual({ ...updates.webdav, remote_path: '/codex-sync' });
    expect(validateConfig(cfg)).toEqual([]);
    expect(yaml.load(readFileSync(configPath, 'utf8'))).toEqual(updates);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'private')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(directory, 'private'))).toEqual(['config.yml']);
  });

  test('merges edited fields while preserving existing sections and directory permissions', () => {
    const existingDirectory = join(directory, 'existing');
    mkdirSync(existingDirectory, { mode: 0o755 });
    const configPath = join(existingDirectory, 'config.yml');
    writeFileSync(configPath, yaml.dump({
      machine_id: 'company',
      webdav: { url: 'https://old.test/dav', username: 'alice', password: 'keep-secret' },
      sync: { direction: 'push', compare: 'mtime_hash_fallback' },
      custom: { enabled: true },
    }), { mode: 0o644 });
    const directoryMode = statSync(existingDirectory).mode & 0o777;

    saveConfig(configPath, { webdav: { url: 'https://new.test/dav' }, sync: { direction: 'pull' } });

    const saved = yaml.load(readFileSync(configPath, 'utf8'));
    expect(saved).toEqual({
      machine_id: 'company',
      webdav: { url: 'https://new.test/dav', username: 'alice', password: 'keep-secret' },
      sync: { direction: 'pull', compare: 'mtime_hash_fallback' },
      custom: { enabled: true },
    });
    expect(statSync(existingDirectory).mode & 0o777).toBe(directoryMode);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(existingDirectory)).toEqual(['config.yml']);
  });

  test.each(['webdav: [broken', 'not-a-mapping', '- array'])('does not overwrite an invalid existing file: %s', (contents) => {
    const configPath = join(directory, 'config.yml');
    writeFileSync(configPath, contents);
    expect(() => saveConfig(configPath, { machine_id: 'home' })).toThrow();
    expect(readFileSync(configPath, 'utf8')).toBe(contents);
    expect(readdirSync(directory)).toEqual(['config.yml']);
  });

  test('propagates file read and destination errors', () => {
    expect(() => saveConfig(directory, { machine_id: 'home' })).toThrow();
    const blockedParent = join(directory, 'file');
    writeFileSync(blockedParent, 'keep');
    expect(() => saveConfig(join(blockedParent, 'config.yml'), { machine_id: 'home' })).toThrow();
    expect(readFileSync(blockedParent, 'utf8')).toBe('keep');
  });

  test('does not expose saved passwords in YAML parsing errors', () => {
    const configPath = join(directory, 'config.yml');
    writeFileSync(configPath, 'webdav:\n  password: secret-value\n  url: [broken');
    for (const operation of [
      () => loadConfig(configPath),
      () => saveConfig(configPath, { machine_id: 'home' }),
    ]) {
      expect(operation).toThrow(`Cannot parse config file: ${configPath}`);
      try { operation(); } catch (error) { expect(error.message).not.toContain('secret-value'); }
    }
  });

  test('merges without mutating inputs and rejects prototype keys', () => {
    const base = { webdav: { username: 'alice', password: 'secret' }, sync: { direction: 'push' } };
    const updates = { webdav: { username: 'bob' } };
    expect(mergeConfig(base, updates).webdav).toEqual({ username: 'bob', password: 'secret' });
    expect(base.webdav.username).toBe('alice');
    expect(updates.webdav).toEqual({ username: 'bob' });
    expect(() => mergeConfig(base, JSON.parse('{"webdav":{"__proto__":{"polluted":true}}}')))
      .toThrow('Unsafe config key');
    expect({}.polluted).toBeUndefined();
  });
});
