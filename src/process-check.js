// src/process-check.js — 检测会话客户端进程并终止 Codex 进程
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** 各平台的进程名常量 */
export const CODEX_PROCESS_NAMES = {
  windows: ['codex.exe', 'codex-windows-sandbox'],
  posix: ['codex'],
};

export const CLAUDE_PROCESS_NAMES = {
  windows: ['claude.exe', 'claude'],
  posix: ['claude', 'claude.exe'],
};

const isWindows = process.platform === 'win32';

/**
 * @param {{ platform?: string, exec?: (command: string) => Promise<{stdout: string}> }} options
 * @returns {Promise<{state: 'running'|'stopped'|'unknown', method: string, error?: string}>}
 */
async function getProcessState(processNames, { platform = process.platform, exec = execAsync } = {}) {
  if (platform === 'win32') {
    try {
      const { stdout } = await exec('tasklist /fo csv /nh');
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const names = [];

      for (const line of lines) {
        const match = line.match(/^"([^"]+)"/);
        if (!match) {
          return { state: 'unknown', method: 'tasklist', error: `Unrecognized tasklist output: ${line}` };
        }
        names.push(match[1].toLowerCase());
      }

      const running = processNames.windows.some((name) => names.includes(name.toLowerCase()));
      return { state: running ? 'running' : 'stopped', method: 'tasklist' };
    } catch (err) {
      return { state: 'unknown', method: 'tasklist', error: err.message };
    }
  }

  for (const name of processNames.posix) {
    try {
      await exec(`pgrep -x ${name}`);
      return { state: 'running', method: 'pgrep' };
    } catch (err) {
      if (err.code === 1) continue;
      return { state: 'unknown', method: 'pgrep', error: err.message };
    }
  }
  return { state: 'stopped', method: 'pgrep' };
}

/**
 * Detect Codex without treating an unavailable or denied process command as stopped.
 */
export async function getCodexProcessState(options = {}) {
  return getProcessState(CODEX_PROCESS_NAMES, options);
}

/** Detect Claude Code with the same fail-closed process check as Codex. */
export async function getClaudeProcessState(options = {}) {
  return getProcessState(CLAUDE_PROCESS_NAMES, options);
}

async function isProcessRunning(clientName, getState, options) {
  const result = await getState(options);
  if (result.state === 'unknown') {
    throw new Error(`Unable to determine whether ${clientName} is running: ${result.error}`);
  }
  return result.state === 'running';
}

/** Backwards-compatible boolean API. Unknown detection must not be mistaken for stopped. */
export async function isCodexRunning(options = {}) {
  return isProcessRunning('Codex', getCodexProcessState, options);
}

/** Unknown detection must not be mistaken for a stopped Claude Code process. */
export async function isClaudeRunning(options = {}) {
  return isProcessRunning('Claude Code', getClaudeProcessState, options);
}

/**
 * 终止 Codex 进程
 * @param {{ force?: boolean }} opts
 * @returns {Promise<void>}
 * @throws 终止失败时抛出错误
 */
export async function terminateCodex(opts = {}) {
  if (isWindows) {
    await terminateCodexWindows(opts);
  } else {
    await terminateCodexPosix(opts);
  }
}

async function terminateCodexWindows(_opts) {
  // Windows 始终用 /f 强制终止，确保可靠
  for (const name of CODEX_PROCESS_NAMES.windows) {
    try {
      await execAsync(`taskkill /im "${name}" /f`);
    } catch (err) {
      // 进程不存在时 taskkill 会报错（退出码 128），忽略该情况
      if (!err.stderr?.includes('not found') && !err.stderr?.includes('找不到')) {
        throw new Error(`Failed to terminate ${name}: ${err.message}`);
      }
    }
  }
}

async function terminateCodexPosix(opts) {
  const sig = opts.force ? '-9' : '-15';
  for (const name of CODEX_PROCESS_NAMES.posix) {
    try {
      await execAsync(`pkill ${sig} -x ${name}`);
    } catch (err) {
      // pkill 退出码 1 表示进程未找到，忽略
      if (err.code !== 1) {
        throw new Error(`Failed to terminate ${name}: ${err.message}`);
      }
    }
  }
}
