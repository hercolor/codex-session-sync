import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const cli = fileURLToPath(new URL('../bin/cxsync.js', import.meta.url));
let directory;
let configPath;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cxsync-cli-config-'));
  configPath = join(directory, 'config.yml');
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(...args) {
  return spawnSync(process.execPath, [cli, '-c', configPath, ...args], {
    encoding: 'utf8', timeout: 5000,
  });
}

describe('CLI configuration errors', () => {
  test('reports an explicit missing config without silently loading defaults', () => {
    const result = run('plan', '--client', 'claude');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Config file not found: ${configPath}`);
    expect(result.stderr).toContain('init-config --output');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  test.each([
    ['plan', '--client', 'claude'],
    ['push', '--client', 'claude'],
    ['pull', '--client', 'codex'],
  ])('%s checks the WebDAV config before scanning or checking running clients', (...args) => {
    writeFileSync(configPath, 'webdav:\n  url: ""\n');
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Invalid configuration at ${configPath}`);
    expect(result.stderr).toContain('webdav.url is required');
    expect(result.stderr).toContain('cxsync serve');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  test('local session listing does not require a WebDAV account', () => {
    const claudeHome = join(directory, 'claude');
    mkdirSync(claudeHome);
    writeFileSync(configPath, yaml.dump({ claude_home: claudeHome }));
    const result = run('sessions', '--client', 'claude');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
