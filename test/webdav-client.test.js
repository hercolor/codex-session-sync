import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import { createWebDAVClient } from '../src/webdav-client.js';

function statXml(path, type, size = 0) {
  const href = `${encodeURI(path)}${type === 'directory' && path !== '/' ? '/' : ''}`;
  return `<?xml version="1.0" encoding="utf-8"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response><d:href>${href}</d:href><d:propstat><d:prop>
        <d:resourcetype>${type === 'directory' ? '<d:collection/>' : ''}</d:resourcetype>
        <d:getlastmodified>Fri, 09 Oct 2026 00:00:00 GMT</d:getlastmodified>
        <d:getcontentlength>${size}</d:getcontentlength>
      </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`;
}

describe('WebDAV directory creation and upload errors', () => {
  let server;
  let url;
  let resources;
  let requests;
  let mkcolResponses;
  let putStatus;

  beforeEach(async () => {
    resources = new Map([['/', { type: 'directory' }]]);
    requests = [];
    mkcolResponses = new Map();
    putStatus = 201;
    server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const path = decodeURIComponent(request.url).replace(/\/$/, '') || '/';
      requests.push({ method: request.method, path, rawPath: request.url });
      const respond = (status, body = '') => {
        response.writeHead(status, { 'Content-Type': 'application/xml' });
        response.end(body);
      };

      if (request.method === 'PROPFIND') {
        const resource = resources.get(path);
        if (!resource) return respond(404);
        return respond(207, statXml(path, resource.type, resource.buffer?.length));
      }
      if (request.method === 'MKCOL') {
        const configured = mkcolResponses.get(path);
        if (configured) {
          if (configured.create) resources.set(path, { type: configured.type ?? 'directory' });
          return respond(configured.status);
        }
        if (resources.has(path)) return respond(405);
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        if (resources.get(parent)?.type !== 'directory') return respond(409);
        resources.set(path, { type: 'directory' });
        return respond(201);
      }
      if (request.method === 'PUT') {
        if (putStatus >= 400) return respond(putStatus);
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        if (resources.get(parent)?.type !== 'directory') return respond(409);
        resources.set(path, { type: 'file', buffer: Buffer.concat(chunks) });
        return respond(putStatus);
      }
      return respond(405);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  function client(remote_path = '/codex-sync-claude') {
    return createWebDAVClient({ url, remote_path });
  }

  test('reports a forbidden new root collection and never attempts PUT after MKCOL 405', async () => {
    mkcolResponses.set('/codex-sync-claude', { status: 405 });
    await expect(client().putFile('projects/project/memory/context.md', Buffer.from('context')))
      .rejects.toMatchObject({
        status: 405,
        message: expect.stringContaining('MKCOL /codex-sync-claude failed (HTTP 405)'),
      });
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
    expect(resources.has('/codex-sync-claude')).toBe(false);
  });

  test('creates nested directories under an existing share without recreating the share', async () => {
    resources.set('/Rclone', { type: 'directory' });
    const data = Buffer.from('portable context');
    await client('/Rclone/cxsync/claude').putFile('projects/project/memory/context.md', data);
    expect(resources.get('/Rclone/cxsync/claude/projects/project/memory/context.md')?.buffer).toEqual(data);
    expect(requests.filter(({ method, path }) => method === 'MKCOL' && path === '/Rclone'))
      .toHaveLength(0);
  });

  test.each([403, 405, 409])('continues after MKCOL %i only when stat confirms a directory was created concurrently', async (status) => {
    resources.set('/Rclone', { type: 'directory' });
    mkcolResponses.set('/Rclone/claude', { status, create: true });
    await client('/Rclone/claude').putFile('projects/project/context.jsonl', Buffer.from('context'));
    expect(resources.get('/Rclone/claude/projects/project/context.jsonl')?.buffer)
      .toEqual(Buffer.from('context'));
    expect(requests.filter(({ method, path }) => method === 'PROPFIND' && path === '/Rclone/claude'))
      .toHaveLength(2);
  });

  test.each([403, 409])('preserves MKCOL %i when the directory remains missing', async (status) => {
    resources.set('/Rclone', { type: 'directory' });
    mkcolResponses.set('/Rclone/claude', { status });
    const error = await client('/Rclone/claude').putFile('context.jsonl', Buffer.from('context'))
      .catch((failure) => failure);
    expect(error).toMatchObject({ status });
    expect(error.message).toContain(`MKCOL /Rclone/claude failed (HTTP ${status})`);
    expect(error.message).toContain('existing WebDAV shared folder');
    expect(error.message).toContain('write permission');
    expect(error.message).not.toContain(url);
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
  });

  test('rejects a regular file used as an ancestor before MKCOL or PUT', async () => {
    resources.set('/Rclone', { type: 'file', buffer: Buffer.from('not a directory') });
    await expect(client('/Rclone/claude').putFile('context.jsonl', Buffer.from('context')))
      .rejects.toThrow('WebDAV path is not a directory: /Rclone');
    expect(requests.filter(({ method }) => method === 'MKCOL' || method === 'PUT')).toHaveLength(0);
  });

  test('does not accept a file found after a failed MKCOL as an existing directory', async () => {
    resources.set('/Rclone', { type: 'directory' });
    mkcolResponses.set('/Rclone/claude', { status: 405, create: true, type: 'file' });
    await expect(client('/Rclone/claude').putFile('context.jsonl', Buffer.from('context')))
      .rejects.toMatchObject({ status: 405, message: expect.stringContaining('MKCOL /Rclone/claude') });
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
  });

  test('identifies an actual file upload permission error as PUT, preserving its status', async () => {
    resources.set('/Rclone', { type: 'directory' });
    resources.set('/Rclone/claude', { type: 'directory' });
    putStatus = 403;
    await expect(client('/Rclone/claude').putFile('context.jsonl', Buffer.from('context')))
      .rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('PUT /Rclone/claude/context.jsonl failed (HTTP 403)'),
      });
    expect(requests.filter(({ method }) => method === 'MKCOL')).toHaveLength(0);
  });

  test('joins a root remote path without double slashes', async () => {
    await client('/').putFile('projects/project/context.jsonl', Buffer.from('context'));
    expect(resources.get('/projects/project/context.jsonl')?.buffer).toEqual(Buffer.from('context'));
    expect(requests.some(({ rawPath }) => rawPath.startsWith('//'))).toBe(false);
  });
});
