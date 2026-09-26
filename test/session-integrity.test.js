// test/session-integrity.test.js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSessionIntegrity } from '../src/session-integrity.js';

let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cxsync-integrity-'));
  mkdirSync(join(home, 'sessions/2026/09/26'), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function rollout(name, body) {
  writeFileSync(join(home, 'sessions/2026/09/26', name), body);
}

describe('checkSessionIntegrity', () => {
  test('reports index/rollout mismatches and absolute cwd', async () => {
    rollout(
      'rollout-2026-09-26T10-00-00-019f1b39-1111-4111-8111-019f1b391111.jsonl',
      '{"type":"session_meta","payload":{"cwd":"/tmp/project"}}\n{"type":"message"}\n',
    );
    writeFileSync(join(home, 'session_index.jsonl'),
      '{"id":"019f1b39-1111-4111-8111-019f1b391111"}\n{"id":"missing-id"}\n');

    const report = await checkSessionIntegrity(home);
    expect(report.ok).toBe(true);
    expect(report.summary.matched).toBe(1);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'absolute_cwd',
      'index_without_rollout',
    ]));
  });

  test('flags empty and truncated rollout files', async () => {
    rollout('rollout-empty.jsonl', '');
    rollout('rollout-broken.jsonl', '{"type":"session_meta"}\n{"type":"message"');
    writeFileSync(join(home, 'session_index.jsonl'), '');

    const report = await checkSessionIntegrity(home);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'empty_rollout',
      'truncated_jsonl',
    ]));
  });

  test('flags malformed index lines and duplicate ids', async () => {
    rollout('rollout-abc.jsonl', '{"type":"session_meta"}\n');
    writeFileSync(join(home, 'session_index.jsonl'),
      '{"id":"sessions/2026/09/26/rollout-abc"}\nnot-json\n{"id":"sessions/2026/09/26/rollout-abc"}\n');

    const report = await checkSessionIntegrity(home);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'invalid_index_jsonl',
      'duplicate_index_id',
    ]));
  });

  test('classifies a truncated final index record', async () => {
    writeFileSync(join(home, 'session_index.jsonl'), '{"id":"unfinished"');
    const report = await checkSessionIntegrity(home);
    expect(report.issues.map((issue) => issue.code)).toContain('truncated_index_jsonl');
  });
});
