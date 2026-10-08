import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isClaudeSyncablePath, scanClaudeHome } from '../src/claude-scanner.js';

const ID = '019f1b39-1111-4111-8111-019f1b391111';
let tempDir;
let claudeHome;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cxsync-claude-scan-'));
  claudeHome = join(tempDir, '.claude');
  mkdirSync(claudeHome);
});

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

function put(rel, contents = 'test') {
  const path = join(claudeHome, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe('isClaudeSyncablePath', () => {
  test('accepts only project sessions, session attachments, and project memory', () => {
    for (const rel of [
      `projects/-tmp-code/${ID}.jsonl`,
      `projects/-tmp-code/${ID}/subagents/agent-a.jsonl`,
      `projects/-tmp-code/${ID}/tool-results/run/result.txt`,
      'projects/-tmp-code/memory/MEMORY.md',
      'projects/-tmp-code/memory/notes/topic.md',
    ]) expect(isClaudeSyncablePath(rel)).toBe(true);
  });

  test('rejects global data, unscoped files, and unsafe paths', () => {
    for (const rel of [
      'settings.json', '.credentials.json', 'sessions/session.jsonl', 'cache/data',
      'projects/-tmp-code/settings.local.json',
      'projects/-tmp-code/agent-a.jsonl',
      'projects/-tmp-code/memory',
      `projects/-tmp-code/${ID}/config.json`,
      `projects/-tmp-code/${ID}/subagents`,
      `projects/-tmp-code/${ID}/../memory/MEMORY.md`,
      `projects//${ID}.jsonl`,
      `projects/-tmp-code/memory/../../settings.json`,
      `projects\\-tmp-code\\${ID}.jsonl`,
      '/projects/-tmp-code/memory/MEMORY.md',
      'projects/-tmp-code/memory/file:stream',
      'projects/-tmp-code/memory/\0secret',
      'projects/-tmp-code/memory/draft.tmp',
      `projects/-tmp-code/${ID}/subagents/agent-1.bak`,
    ]) expect(isClaudeSyncablePath(rel)).toBe(false);
  });
});

describe('scanClaudeHome', () => {
  test('collects only allowed files and session metadata', async () => {
    const session = put(`projects/-tmp-code/${ID}.jsonl`, '{"type":"user"}\n');
    put(`projects/-tmp-code/${ID}/subagents/agent-a.jsonl`);
    put(`projects/-tmp-code/${ID}/tool-results/run/result.txt`);
    put('projects/-tmp-code/memory/MEMORY.md');
    put('projects/-tmp-code/memory/notes/topic.md');
    put('projects/-tmp-code/memory/draft.tmp');
    put('settings.json');
    put('.credentials.json');
    put('sessions/other.jsonl');
    put('cache/data');
    put('projects/-tmp-code/settings.local.json');
    put('projects/-tmp-code/agent-a.jsonl');
    put(`projects/-tmp-code/${ID}/config.json`);
    put(`projects/-tmp-code/${ID}/other/secret.txt`);

    const result = await scanClaudeHome(claudeHome);
    expect(result.allFiles.map((file) => file.rel)).toEqual([
      `projects/-tmp-code/${ID}.jsonl`,
      `projects/-tmp-code/${ID}/subagents/agent-a.jsonl`,
      `projects/-tmp-code/${ID}/tool-results/run/result.txt`,
      'projects/-tmp-code/memory/MEMORY.md',
      'projects/-tmp-code/memory/notes/topic.md',
    ]);
    expect(result.allFiles[0]).toEqual(expect.objectContaining({ absPath: session, size: 16 }));
    expect(result.sessions).toEqual([expect.objectContaining({
      id: ID,
      project: '-tmp-code',
      file: session,
    })]);
  });

  test('does not follow linked project files or directories', async () => {
    const outside = join(tempDir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'private');
    put(`projects/-tmp-code/${ID}.jsonl`);
    symlinkSync(join(outside, 'secret.txt'), join(claudeHome, 'projects/-tmp-code/memory-file-link'));
    mkdirSync(join(claudeHome, 'projects/-tmp-code/memory'));
    symlinkSync(join(outside, 'secret.txt'), join(claudeHome, 'projects/-tmp-code/memory/linked.txt'));
    symlinkSync(outside, join(claudeHome, 'projects/-tmp-code/memory/linked-dir'));
    mkdirSync(join(claudeHome, `projects/-tmp-code/${ID}`));
    symlinkSync(outside, join(claudeHome, `projects/-tmp-code/${ID}/subagents`));

    const result = await scanClaudeHome(claudeHome);
    expect(result.allFiles.map((file) => file.rel)).toEqual([`projects/-tmp-code/${ID}.jsonl`]);
  });

  test('allows an absent home or projects directory for initial pull', async () => {
    expect(await scanClaudeHome(join(tempDir, 'missing'))).toEqual({ allFiles: [], sessions: [] });
    expect(await scanClaudeHome(claudeHome)).toEqual({ allFiles: [], sessions: [] });
  });

  test('fails closed when projects is not a readable directory', async () => {
    put('projects', 'not a directory');
    await expect(scanClaudeHome(claudeHome)).rejects.toThrow('not a directory');
  });

  test('rejects a symbolic-link projects root', async () => {
    const outside = join(tempDir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(claudeHome, 'projects'));
    await expect(scanClaudeHome(claudeHome)).rejects.toThrow('symbolic link');
  });
});
