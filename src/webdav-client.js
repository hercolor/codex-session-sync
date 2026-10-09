// src/webdav-client.js — 封装 webdav npm 包，提供统一的 WebDAV 操作接口
import { createClient } from 'webdav';

/**
 * 创建 WebDAV 客户端实例
 * @param {{ url, username, password, remote_path }} webdavConfig
 * @returns {object} client
 */
export function createWebDAVClient(webdavConfig) {
  const { url, username, password, remote_path = '/codex-sync' } = webdavConfig;

  if (!url) throw new Error('WebDAV url is required');

  // 创建底层 webdav 包客户端
  const raw = createClient(url, {
    username: username || undefined,
    password: password || undefined,
  });

  // 规范化 remote_path：确保以 / 开头、不以 / 结尾
  const baseRemotePath = ('/' + remote_path.replace(/^\//, '')).replace(/\/$/, '') || '/';

  /**
   * 拼接完整远端路径
   * @param {string} rel  相对路径
   */
  function fullPath(rel) {
    const normalized = rel.replace(/\\/g, '/').replace(/^\//, '');
    return baseRemotePath === '/' ? '/' + normalized : baseRemotePath + '/' + normalized;
  }

  return {
    /**
     * 列出远端目录内容（递归）
     * 注意：不用 deep:true（Depth: infinity），许多服务器出于安全默认拒绝（403），
     * 改为逐层 Depth:1 递归，兼容性更好。
     * @param {string} remotePath  相对于 remote_path 的路径，默认为根
     * @returns {Promise<Array<{ rel, mtime, size }>>}
     */
    async list(remotePath = '') {
      const target = remotePath ? fullPath(remotePath) : baseRemotePath;
      const files = [];
      await listRecursive(raw, target, files);
      return files.map(item => ({
        // rel 相对于 baseRemotePath
        rel: item.filename.replace(baseRemotePath, '').replace(/^\//, '').replace(/\\/g, '/'),
        mtime: new Date(item.lastmod).getTime(),
        size: item.size ?? 0,
      }));
    },

    /**
     * 获取远端文件元数据
     * @param {string} remotePath
     * @returns {Promise<{ mtime, size } | null>}
     */
    async stat(remotePath) {
      try {
        const item = await raw.stat(fullPath(remotePath));
        return {
          mtime: new Date(item.lastmod).getTime(),
          size: item.size ?? 0,
        };
      } catch (err) {
        // 文件不存在时返回 null
        if (err?.status === 404 || err?.response?.status === 404) return null;
        throw err;
      }
    },

    /**
     * 下载远端文件，返回 Buffer
     * @param {string} remotePath
     * @returns {Promise<Buffer>}
     */
    async getFile(remotePath) {
      const data = await raw.getFileContents(fullPath(remotePath));
      // webdav v5 返回 Buffer 或 ArrayBuffer
      if (Buffer.isBuffer(data)) return data;
      return Buffer.from(data);
    },

    /**
     * 上传文件到远端
     * @param {string} remotePath
     * @param {Buffer} buffer
     */
    async putFile(remotePath, buffer) {
      const target = fullPath(remotePath);
      // 确保父目录存在
      await ensureRemoteDir(raw, dirOf(target));
      try {
        await raw.putFileContents(target, buffer, { overwrite: true });
      } catch (err) {
        throw remoteOperationError('PUT', target, err);
      }
    },

    /**
     * 创建远端目录（包括中间目录）
     * @param {string} remotePath
     */
    async mkdir(remotePath) {
      await ensureRemoteDir(raw, fullPath(remotePath));
    },

    /**
     * 测试连通性
     * 远端目录不存在（404）视为连接成功——首次同步时会自动创建
     * @returns {Promise<{ ok: boolean, latency_ms: number, error?: string }>}
     */
    async testConnection() {
      const start = Date.now();
      try {
        await raw.getDirectoryContents(baseRemotePath);
        return { ok: true, latency_ms: Date.now() - start };
      } catch (err) {
        const status = err?.status ?? err?.response?.status;
        if (status === 404) return { ok: true, latency_ms: Date.now() - start };
        return { ok: false, latency_ms: Date.now() - start, error: err.message };
      }
    },
  };
}

// ─── 内部辅助 ─────────────────────────────────────────────────────────────────

/**
 * 逐层递归列出目录下所有文件（Depth: 1 PROPFIND）
 * 目录不存在（404）时静默返回
 */
async function listRecursive(rawClient, dirPath, acc) {
  let items;
  try {
    items = await rawClient.getDirectoryContents(dirPath);
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 404) return;
    throw err;
  }
  for (const item of items) {
    if (item.type === 'file') acc.push(item);
    else if (item.type === 'directory') await listRecursive(rawClient, item.filename, acc);
  }
}

/**
 * 递归确保远端目录存在（逐级创建）
 */
async function ensureRemoteDir(rawClient, dirPath) {
  if (!dirPath || dirPath === '/') return;
  let currentPath = '';
  for (const segment of dirPath.split('/').filter(Boolean)) {
    currentPath += '/' + segment;
    let item;
    try {
      item = await rawClient.stat(currentPath);
    } catch (err) {
      if (httpStatus(err) !== 404) {
        throw remoteOperationError('PROPFIND', currentPath, err, true);
      }
    }
    if (item) {
      if (item.type !== 'directory') {
        throw new Error(`WebDAV path is not a directory: ${currentPath}`);
      }
      continue;
    }

    try {
      await rawClient.createDirectory(currentPath);
    } catch (err) {
      // 群晖根目录可能返回 405，不能据此认定目录存在。
      // 仅再次确认目录确实存在时，才接受其他客户端同时创建目录的情况。
      let existing;
      try { existing = await rawClient.stat(currentPath); }
      catch { /* 保留创建失败的操作、路径及状态。 */ }
      if (existing?.type !== 'directory') {
        throw remoteOperationError('MKCOL', currentPath, err, true);
      }
    }
  }
}

function httpStatus(err) {
  return err?.status ?? err?.response?.status ?? err?.response?.statusCode;
}

/** 错误信息只包含操作、远端路径及状态，不传播 URL、凭据或响应头。 */
function remoteOperationError(operation, remotePath, original, directory = false) {
  const status = httpStatus(original);
  const detail = status == null ? '' : ` (HTTP ${status})`;
  const hint = directory
    ? 'Check that the remote path is under an existing WebDAV shared folder and that the account has write permission.'
    : 'Check write permission for the remote file.';
  const error = new Error(`WebDAV ${operation} ${remotePath} failed${detail}. ${hint}`);
  if (status != null) error.status = status;
  return error;
}

/**
 * 取路径的父目录部分
 */
function dirOf(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/') || '/';
}
