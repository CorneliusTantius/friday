import { homedir } from 'node:os';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const defaultRoot = join(homedir(), '.friday', 'workspace', 'notes');

function contained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function safeFile(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')) return null;
  const path = resolve(root, name);
  if (!contained(root, path) || extname(path).toLowerCase() !== '.md') return null;
  try {
    const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!info.isFile() || !contained(await realpath(root), canonical)) return null;
    return path;
  } catch { return null; }
}

export async function browseNotes({ root = defaultRoot } = {}) {
  const base = resolve(root);
  let canonicalRoot;
  try { canonicalRoot = await realpath(base); } catch { return []; }
  const notes = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await walk(path);
        else if (info.isFile() && extname(entry.name).toLowerCase() === '.md') {
          const canonical = await realpath(path);
          if (contained(canonicalRoot, canonical)) notes.push(relative(base, path).split(sep).join('/'));
        }
      } catch { /* Ignore entries that disappear or cannot be inspected. */ }
    }
  }
  await walk(base);
  return notes.sort((a, b) => a.localeCompare(b));
}

export async function readNote(name, { root = defaultRoot, maxBytes = 1_000_000 } = {}) {
  const base = resolve(root);
  const path = await safeFile(base, name);
  if (!path) return null;
  try {
    const info = await lstat(path);
    if (info.size > maxBytes) return null;
    return await readFile(path, 'utf8');
  } catch { return null; }
}
