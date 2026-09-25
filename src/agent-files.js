import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { lstat, mkdir, readdir, realpath, readFile } from 'node:fs/promises';

export const MAX_AGENT_FILE_BYTES = 1024 * 1024;
export const MAX_AGENT_ENTRIES = 1000;
const secretName = /^(auth\.json|credentials\.json|settings\.json|models\.json|\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key))$/i;
const secretText = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?\S+)/i;

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
function safeName(name) { return !name.startsWith('.') && !secretName.test(name); }
function within(root, path) { return path === root || path.startsWith(`${root}${sep}`); }
function relativePath(input = '') {
  if (typeof input !== 'string' || input.includes('\\') || input.startsWith('/') || input.split('/').some((part) => part === '..' || part === '.')) throw new Error('invalid file path');
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

export async function listAgentFiles({ root, path = '', home = homedir(), env = process.env } = {}) {
  const base = await prepareRoot(rootPath(root, home, env));
  const rel = relativePath(path);
  if (rel.split('/').some((part) => part && !safeName(part))) throw new Error('file path is unavailable');
  const target = resolve(base, rel);
  if (!within(base, target)) throw new Error('path outside root');
  await rejectSymlinkComponents(base, rel);
  let canonical;
  try { canonical = await realpath(target); } catch { throw new Error('directory not found'); }
  if (!within(base, canonical)) throw new Error('path outside root');
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('path is not a directory');
  const names = await readdir(target, { withFileTypes: true });
  if (names.length > MAX_AGENT_ENTRIES) throw new Error(`directory exceeds ${MAX_AGENT_ENTRIES} entries`);
  const entries = [];
  for (const item of names) {
    if (!safeName(item.name)) continue;
    const child = join(target, item.name);
    const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
    entries.push({ name: item.name, path: rel ? `${rel}/${item.name}` : item.name, type: info.isDirectory() ? 'directory' : 'file', size: info.isFile() ? info.size : null, modified: info.mtime.toISOString(), workspacePath: null });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return { root, directory: base, path: rel, entries };
}

export async function readAgentFile({ root, path, home = homedir(), env = process.env, maxBytes = MAX_AGENT_FILE_BYTES } = {}) {
  const base = await prepareRoot(rootPath(root, home, env));
  const rel = relativePath(path);
  if (!rel) throw new Error('file path required');
  if (rel.split('/').some((part) => !safeName(part))) throw new Error('file cannot be previewed');
  const target = resolve(base, rel);
  if (!within(base, target)) throw new Error('path outside root');
  await rejectSymlinkComponents(base, rel);
  let canonical;
  try { canonical = await realpath(target); } catch { throw new Error('file not found'); }
  if (!within(base, canonical)) throw new Error('path outside root');
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || !safeName(rel.split('/').at(-1))) throw new Error('file cannot be previewed');
  if (info.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
  const data = await readFile(target);
  if (data.length > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
  if (data.includes(0)) throw new Error('binary files cannot be previewed');
  const content = data.toString('utf8');
  if (secretText.test(content)) throw new Error('file contains credential-like content');
  return { root, path: rel, workspacePath: null, size: data.length, modified: info.mtime.toISOString(), content };
}
