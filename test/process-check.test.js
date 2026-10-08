import { describe, test, expect } from '@jest/globals';
import {
  getClaudeProcessState,
  getCodexProcessState,
  isClaudeRunning,
  isCodexRunning,
} from '../src/process-check.js';

describe('getCodexProcessState', () => {
  test('distinguishes running and stopped on POSIX', async () => {
    const running = await getCodexProcessState({
      platform: 'linux',
      exec: async () => ({ stdout: '123\n' }),
    });
    expect(running).toEqual({ state: 'running', method: 'pgrep' });

    const stopped = await getCodexProcessState({
      platform: 'darwin',
      exec: async () => { throw Object.assign(new Error('no matches'), { code: 1 }); },
    });
    expect(stopped).toEqual({ state: 'stopped', method: 'pgrep' });
  });

  test('reports command failures as unknown on POSIX', async () => {
    const result = await getCodexProcessState({
      platform: 'linux',
      exec: async () => { throw Object.assign(new Error('permission denied'), { code: 13 }); },
    });
    expect(result).toEqual({ state: 'unknown', method: 'pgrep', error: 'permission denied' });
  });

  test('parses Windows tasklist and reports command or output errors as unknown', async () => {
    const running = await getCodexProcessState({
      platform: 'win32',
      exec: async () => ({ stdout: '"codex.exe","123","Console","1","10,000 K"\r\n' }),
    });
    expect(running).toEqual({ state: 'running', method: 'tasklist' });

    const failed = await getCodexProcessState({
      platform: 'win32',
      exec: async () => { throw new Error('tasklist unavailable'); },
    });
    expect(failed).toEqual({ state: 'unknown', method: 'tasklist', error: 'tasklist unavailable' });

    const malformed = await getCodexProcessState({
      platform: 'win32',
      exec: async () => ({ stdout: 'unexpected output' }),
    });
    expect(malformed.state).toBe('unknown');
  });

  test('legacy API throws when process state is unknown', async () => {
    await expect(isCodexRunning({
      platform: 'linux',
      exec: async () => { throw Object.assign(new Error('pgrep missing'), { code: 'ENOENT' }); },
    })).rejects.toThrow('pgrep missing');
  });
});

describe('Claude Code process detection', () => {
  test('recognizes both executable names and stopped processes on POSIX', async () => {
    const commands = [];
    const running = await getClaudeProcessState({
      platform: 'linux',
      exec: async (command) => {
        commands.push(command);
        if (command.endsWith('claude')) {
          throw Object.assign(new Error('no matches'), { code: 1 });
        }
        return { stdout: '123\n' };
      },
    });
    expect(running).toEqual({ state: 'running', method: 'pgrep' });
    expect(commands).toEqual(['pgrep -x claude', 'pgrep -x claude.exe']);

    const stopped = await getClaudeProcessState({
      platform: 'darwin',
      exec: async () => { throw Object.assign(new Error('no matches'), { code: 1 }); },
    });
    expect(stopped).toEqual({ state: 'stopped', method: 'pgrep' });
    await expect(isClaudeRunning({
      platform: 'linux',
      exec: async () => ({ stdout: '123\n' }),
    })).resolves.toBe(true);
  });

  test('recognizes Windows tasklist names exactly', async () => {
    for (const name of ['claude.exe', 'claude']) {
      const running = await getClaudeProcessState({
        platform: 'win32',
        exec: async () => ({ stdout: `"${name}","123","Console","1","10,000 K"\r\n` }),
      });
      expect(running).toEqual({ state: 'running', method: 'tasklist' });
    }

    const stopped = await getClaudeProcessState({
      platform: 'win32',
      exec: async () => ({ stdout: '"claude-helper.exe","123","Console","1","10,000 K"\r\n' }),
    });
    expect(stopped).toEqual({ state: 'stopped', method: 'tasklist' });
  });

  test('reports detection failures as unknown and rejects the boolean API', async () => {
    const unavailable = async () => { throw Object.assign(new Error('pgrep missing'), { code: 'ENOENT' }); };
    await expect(getClaudeProcessState({ platform: 'linux', exec: unavailable })).resolves.toEqual({
      state: 'unknown', method: 'pgrep', error: 'pgrep missing',
    });
    await expect(isClaudeRunning({ platform: 'linux', exec: unavailable }))
      .rejects.toThrow('Unable to determine whether Claude Code is running: pgrep missing');

    const malformed = await getClaudeProcessState({
      platform: 'win32',
      exec: async () => ({ stdout: 'unexpected output' }),
    });
    expect(malformed.state).toBe('unknown');
  });
});
