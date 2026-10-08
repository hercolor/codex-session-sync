import { describe, test, expect } from '@jest/globals';
import { mergeSessionIndexBuffers } from '../src/session-index.js';

describe('mergeSessionIndexBuffers', () => {
  test('preserves distinct ids and picks the newer duplicate deterministically', () => {
    const local = Buffer.from([
      JSON.stringify({ id: 'shared', thread_name: 'old', updated_at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ id: 'local-only', updated_at: '2026-01-02T00:00:00Z' }),
    ].join('\n'));
    const remote = Buffer.from([
      JSON.stringify({ id: 'shared', thread_name: 'new', updated_at: '2026-02-01T00:00:00Z' }),
      JSON.stringify({ id: 'remote-only', updated_at: '2026-01-03T00:00:00Z' }),
    ].join('\n'));

    const merged = mergeSessionIndexBuffers(local, remote);
    const reverse = mergeSessionIndexBuffers(remote, local);
    const entries = merged.toString('utf8').trim().split('\n').map(JSON.parse);

    expect(merged.equals(reverse)).toBe(true);
    expect(entries.map((entry) => entry.id)).toEqual(['shared', 'remote-only', 'local-only']);
    expect(entries[0].thread_name).toBe('new');
  });

  test('uses canonical JSON as a stable tie breaker', () => {
    const left = Buffer.from('{"id":"same","thread_name":"alpha"}\n');
    const right = Buffer.from('{"thread_name":"zeta","id":"same"}\n');

    expect(mergeSessionIndexBuffers(left, right).equals(mergeSessionIndexBuffers(right, left))).toBe(true);
  });

  test('does not silently discard malformed rows or entries without ids', () => {
    expect(() => mergeSessionIndexBuffers(Buffer.from('{"id":"ok"}\nnot-json'), null))
      .toThrow('line 2: malformed JSON');
    expect(() => mergeSessionIndexBuffers(Buffer.from('{"thread_name":"missing id"}'), null))
      .toThrow('line 1: expected an object with a string id');
  });

  test('returns null only when both index files are absent', () => {
    expect(mergeSessionIndexBuffers(null, undefined)).toBeNull();
    expect(mergeSessionIndexBuffers(Buffer.alloc(0), null)).toEqual(Buffer.alloc(0));
  });
});
