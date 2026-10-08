import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';
import { router } from '../src/api/config.js';
import { loadConfig, saveConfig } from '../src/config.js';

describe('config API', () => {
  let directory;
  let configPath;
  let cfg;
  let app;
  let server;
  let baseUrl;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cxsync-config-api-'));
    configPath = join(directory, 'config.yml');
    saveConfig(configPath, {
      machine_id: 'company',
      webdav: { url: 'https://example.test/dav', username: 'alice', password: 'secret' },
      sync: { compare: 'mtime_hash_fallback' },
    });
    cfg = loadConfig(configPath);
    cfg.server.port = 0; // A runtime override must not be written by an unrelated edit.
    app = express();
    app.use(express.json({ strict: false }));
    app.locals.cfg = cfg;
    app.locals.configPath = configPath;
    app.use('/api/config', router);
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  function put(updates) {
    return fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  }

  test('serves the mounted endpoint and masks secrets without altering memory', async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.config_path).toBe(configPath);
    expect(body.webdav.password).toBe('***');
    expect(cfg.webdav.password).toBe('secret');
    expect((await fetch(`${baseUrl}/api/config/config`)).status).toBe(404);
  });

  test('persists edited settings for later CLI loads and updates the shared config', async () => {
    const response = await put({ webdav: { url: 'https://new.test/dav' }, sync: { direction: 'pull' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, config_path: configPath });
    expect(app.locals.cfg).toBe(cfg);
    expect(cfg.webdav).toEqual({
      url: 'https://new.test/dav', username: 'alice', password: 'secret', remote_path: '/codex-sync',
    });
    const reloaded = loadConfig(configPath);
    expect(reloaded.webdav).toEqual(cfg.webdav);
    expect(reloaded.sync.direction).toBe('pull');
    expect(reloaded.sync.compare).toBe('mtime_hash_fallback');
    const persisted = yaml.load(readFileSync(configPath, 'utf8'));
    expect(persisted.server).toBeUndefined();
    expect(persisted.config_path).toBeUndefined();
    expect(persisted.backup_dir).toBeUndefined();
  });

  test.each(['***', ''])('preserves the existing password for an unchanged input %j', async (password) => {
    const response = await put({ webdav: { username: 'bob', password } });
    expect(response.status).toBe(200);
    expect(cfg.webdav.password).toBe('secret');
    expect(loadConfig(configPath).webdav.password).toBe('secret');
    expect(loadConfig(configPath).webdav.username).toBe('bob');
  });

  test('saves an explicitly changed password', async () => {
    expect((await put({ webdav: { password: 'new-secret' } })).status).toBe(200);
    expect(cfg.webdav.password).toBe('new-secret');
    expect(loadConfig(configPath).webdav.password).toBe('new-secret');
    expect((await (await fetch(`${baseUrl}/api/config`)).json()).webdav.password).toBe('***');
  });

  test.each([
    null, [], 'bad', { webdav: null }, { sync: [] }, { server: 'bad' },
    { config_path: '/wrong/config.yml' }, { local_home: '/wrong' },
    { machine_id: {} }, { claude_home: [] },
    { webdav: { url: '' } }, { webdav: { url: 'not-a-url' } },
    { webdav: { url: 'file:///tmp/dav' } }, { webdav: { password: 123 } },
    { sync: { direction: 'wrong' } },
  ])('rejects invalid updates without changing disk or memory: %j', async (updates) => {
    const previous = structuredClone(cfg);
    const previousContents = readFileSync(configPath, 'utf8');
    const response = await put(updates);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
    expect(cfg).toEqual(previous);
    expect(readFileSync(configPath, 'utf8')).toBe(previousContents);
  });

  test('leaves the shared config unchanged if the config cannot be saved', async () => {
    const invalidTarget = join(directory, 'directory-instead-of-file');
    mkdirSync(invalidTarget);
    app.locals.configPath = invalidTarget;
    const previous = structuredClone(cfg);
    const response = await put({ webdav: { username: 'bob' } });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain('Failed to save config');
    expect(cfg).toEqual(previous);
    expect(loadConfig(configPath).webdav.username).toBe('alice');
  });

  test('does not overwrite broken YAML or expose credentials in the error response', async () => {
    const contents = 'webdav:\n  password: secret-value\n  url: [broken';
    writeFileSync(configPath, contents);
    const previous = structuredClone(cfg);
    const response = await put({ webdav: { username: 'bob' } });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Cannot parse config file');
    expect(body.error).not.toContain('secret-value');
    expect(cfg).toEqual(previous);
    expect(readFileSync(configPath, 'utf8')).toBe(contents);
  });
});
