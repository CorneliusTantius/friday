import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';

export const MAX_AGENT_FILE_BYTES = 1024 * 1024;

function rootPath(root, home, env) {
  if (root === 'friday') return resolve(env.FRIDAY_HOME || join(home, '.friday'));
  if (root === 'pi') return resolve(env.PI_CODING_AGENT_DIR ? dirname(resolve(env.PI_CODING_AGENT_DIR)) : join(home, '.pi'));
  throw new Error('root must be friday or pi');
}

async function prepareRoot(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('agent files root must be a directory, not a symlink');
  return realpath(path);
}

function isWithin(root, path) { return path === root || path.startsWith(`${root}${sep}`); }
function relativePath(input = '') {
  if (typeof input !== 'string' || input.includes('\\') || input.includes('\0') || input.startsWith('/') || (input !== '' && input.split('/').some((part) => !part || part === '.' || part === '..'))) throw new Error('invalid file path');
  return input;
}

async function rejectSymlinkComponents(base, rel) {
  let current = base;
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('symbolic links are not available in Files');
  }
}

async function resolveAgentPath(root, path, home, env) {
  const base = await prepareRoot(rootPath(root, home, env));
  const rel = relativePath(path);
  const target = resolve(base, rel);
  if (!isWithin(base, target)) throw new Error('path outside root');
  await rejectSymlinkComponents(base, rel);
  let canonical;
  try { canonical = await realpath(target); } catch { throw new Error('file or directory not found'); }
  if (!isWithin(base, canonical)) throw new Error('path outside root');
  return { base, rel, target };
}

export async function listAgentFiles({ root, path = '', home = homedir(), env = process.env } = {}) {
  const { base, rel, target } = await resolveAgentPath(root, path, home, env);
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('path is not a directory');
  const names = await readdir(target, { withFileTypes: true });
  if (names.length > 1000) throw new Error('directory exceeds 1000 entries');
  const entries = [];
  for (const item of names) {
    const child = join(target, item.name);
    const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
    const childPath = rel ? `${rel}/${item.name}` : item.name;
    entries.push({
      name: item.name,
      path: childPath,
      type: info.isDirectory() ? 'directory' : 'file',
      size: info.isFile() ? info.size : null,
      modified: info.mtime.toISOString(),
      previewable: info.isDirectory() || info.isFile(),
      editable: info.isFile(),
      workspacePath: null,
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return { root, directory: base, path: rel, entries };
}

export async function readAgentFile({ root, path, home = homedir(), env = process.env, maxBytes = MAX_AGENT_FILE_BYTES } = {}) {
  const { rel, target } = await resolveAgentPath(root, path, home, env);
  if (!rel) throw new Error('file path required');
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('file cannot be previewed');
  if (info.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
  const data = await readFile(target);
  if (data.length > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
  if (data.includes(0)) throw new Error('binary files cannot be previewed');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new Error('binary files cannot be previewed'); }
  return {
    root,
    path: rel,
    workspacePath: null,
    size: data.length,
    modified: info.mtime.toISOString(),
    content,
    editable: true,
    editorType: rel.toLowerCase().endsWith('.md') || rel.toLowerCase().endsWith('.markdown') ? 'markdown' : rel.toLowerCase().endsWith('.json') ? 'json' : 'text',
  }; 
}

export async function writeAgentFile({ root, path, content, home = homedir(), env = process.env } = {}) {
  if (typeof content !== 'string') throw new Error('file content is required');
  if (Buffer.byteLength(content) > 512 * 1024) throw new Error('file exceeds 512 KB');
  if (content.includes('\0')) throw new Error('file content contains binary data');

  const { rel, target } = await resolveAgentPath(root, path, home, env);
  if (!rel) throw new Error('file path required');
  if (rel.toLowerCase().endsWith('.json')) {
    try { JSON.parse(content); } catch { throw new Error('content must be valid JSON'); }
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('file cannot be edited');
  if (info.size > MAX_AGENT_FILE_BYTES) throw new Error(`file exceeds ${MAX_AGENT_FILE_BYTES} bytes`);

  const temporary = join(dirname(target), `.friday-edit-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  const updated = await lstat(target);
  return { root, path: rel, size: Buffer.byteLength(content), modified: updated.mtime.toISOString() };
}
