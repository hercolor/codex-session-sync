import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SESSION_ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION_FILE_RE = new RegExp(`^${SESSION_ID}\\.jsonl$`);
const SESSION_DIR_RE = new RegExp(`^${SESSION_ID}$`);

export function isClaudeSyncablePath(rel) {
  if (typeof rel !== 'string' || rel.includes('\\') || /[\x00-\x1f:]/.test(rel)) return false;
  if (/\.(?:bak|tmp)$/i.test(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (parts[0] !== 'projects' || parts.length < 3) return false;

  const tail = parts.slice(2);
  if (tail.length === 1 && SESSION_FILE_RE.test(tail[0])) return true;
  if (tail[0] === 'memory') return tail.length >= 2;
  return SESSION_DIR_RE.test(tail[0]) && tail.length >= 3 &&
    (tail[1] === 'subagents' || tail[1] === 'tool-results');
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function requireDirectory(path, allowMissing = false) {
  const stat = allowMissing ? lstatIfPresent(path) : lstatSync(path);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Claude directory is a symbolic link: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Claude directory is not a directory: ${path}`);
  return true;
}

function addFile(path, rel, allFiles) {
  const stat = lstatSync(path);
  if (!stat.isFile() || !isClaudeSyncablePath(rel)) return;
  allFiles.push({ rel, absPath: path, mtime: stat.mtimeMs, size: stat.size });
}

function walkIncludedDirectory(path, rel, allFiles) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const childPath = join(path, entry.name);
    const childRel = `${rel}/${entry.name}`;
    if (!isClaudeSyncablePath(childRel)) continue;
    const stat = lstatSync(childPath);
    if (stat.isDirectory()) walkIncludedDirectory(childPath, childRel, allFiles);
    else if (stat.isFile()) addFile(childPath, childRel, allFiles);
  }
}

/** Scan only Claude Code project conversations and project memory. */
export async function scanClaudeHome(claudeHome) {
  const home = resolve(claudeHome);
  const projectsPath = join(home, 'projects');
  const allFiles = [];
  if (!requireDirectory(home, true) || !requireDirectory(projectsPath, true)) {
    return { allFiles, sessions: [] };
  }

  for (const project of readdirSync(projectsPath, { withFileTypes: true })) {
    if (project.isSymbolicLink() || !project.isDirectory()) continue;
    const projectPath = join(projectsPath, project.name);
    const projectRel = `projects/${project.name}`;
    if (!isClaudeSyncablePath(`${projectRel}/memory/MEMORY.md`)) continue;
    requireDirectory(projectPath);

    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(projectPath, entry.name);
      const entryRel = `${projectRel}/${entry.name}`;
      if (entry.name === 'memory' && entry.isDirectory()) {
        requireDirectory(entryPath);
        walkIncludedDirectory(entryPath, entryRel, allFiles);
      } else if (SESSION_FILE_RE.test(entry.name) && entry.isFile()) {
        addFile(entryPath, entryRel, allFiles);
      } else if (SESSION_DIR_RE.test(entry.name) && entry.isDirectory()) {
        requireDirectory(entryPath);
        for (const child of readdirSync(entryPath, { withFileTypes: true })) {
          if (child.isSymbolicLink() || !['subagents', 'tool-results'].includes(child.name) || !child.isDirectory()) continue;
          const childPath = join(entryPath, child.name);
          requireDirectory(childPath);
          walkIncludedDirectory(childPath, `${entryRel}/${child.name}`, allFiles);
        }
      }
    }
  }

  allFiles.sort((a, b) => a.rel.localeCompare(b.rel));
  const sessions = allFiles
    .filter((file) => SESSION_FILE_RE.test(file.rel.split('/')[2]))
    .map((file) => ({
      id: file.rel.split('/')[2].slice(0, -'.jsonl'.length),
      project: file.rel.split('/')[1],
      file: file.absPath,
      size_bytes: file.size,
      updated_at: new Date(file.mtime).toISOString(),
    }));
  return { allFiles, sessions };
}
