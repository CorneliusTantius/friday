import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, basename, sep, dirname } from 'node:path';
import { mkdtemp, readdir, lstat, open, readFile, writeFile, mkdir, rm, rename, unlink, chmod, rmdir } from 'node:fs/promises';

const exec = promisify(execFile);
const forbiddenDirectories = new Set(['repos', 'node_modules']);

function validTarget(owner, repo) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner || '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo || '') || repo === '.' || repo === '..') throw new Error('A valid GitHub owner and repository are required');
}

function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git' && !forbiddenDirectories.has(part));
}

function describe(data, mode) {
  return { data, hash: createHash('sha256').update(data).digest('hex'), executable: Boolean(mode & 0o111) };
}

function same(a, b) {
  return a === undefined || b === undefined ? a === b : a.hash === b.hash && a.executable === b.executable;
}

function validateBaseline(value, owner, repo) {
  if (!value || value.owner !== owner || value.repo !== repo || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) return null;
  const files = new Map();
  for (const [path, entry] of Object.entries(value.files)) {
    if (!safeRelativePath(path) || !entry || !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.executable !== 'boolean') return null;
    files.set(path, { hash: entry.hash, executable: entry.executable });
  }
  return files;
}

async function readBaseline(stateFile, owner, repo) {
  if (!stateFile) return null;
  try {
    return validateBaseline(JSON.parse(await readFile(stateFile, 'utf8')), owner, repo);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeBaseline(stateFile, owner, repo, files) {
  if (!stateFile) return;
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(stateFile), 0o700);
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  const entries = Object.fromEntries([...files].map(([path, entry]) => [path, { hash: entry.hash, executable: entry.executable }]));
  try {
    await writeFile(temporary, `${JSON.stringify({ owner, repo, files: entries }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, stateFile);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function scanTree(root, { excluded = [], rejectSymlinks = false } = {}) {
  const result = new Map();
  const unsafe = new Set();
  const resolvedExclusions = excluded.map((path) => resolve(path));
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelativePath(relativePath)) continue;
      const path = join(directory, entry.name);
      const absolute = resolve(path);
      if (resolvedExclusions.some((excludedPath) => absolute === excludedPath || absolute.startsWith(`${excludedPath}${sep}`))) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        if (rejectSymlinks) throw new Error(`Remote snapshot contains a symbolic link: ${relativePath}`);
        unsafe.add(relativePath);
      } else if (info.isDirectory()) {
        if (!forbiddenDirectories.has(entry.name)) await walk(path, relativePath);
      } else if (info.isFile()) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data;
        try {
          const opened = await file.stat();
          if (!opened.isFile()) throw new Error(`Sync entry is not a regular file: ${relativePath}`);
          data = await file.readFile();
        } finally { await file.close(); }
        result.set(relativePath, describe(data, info.mode));
      }
    }
  }
  await walk(root);
  return { files: result, unsafe };
}

async function safeDestination(source, relativePath, createParents) {
  if (!safeRelativePath(relativePath)) throw new Error(`Unsafe sync path: ${relativePath}`);
  const parts = relativePath.split('/');
  let current = source;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe sync path component: ${part}`);
    } catch (error) {
      if (error.code !== 'ENOENT' || !createParents) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return join(source, ...parts);
}

async function applyTreeChanges(root, current, desired) {
  const paths = new Set([...current.keys(), ...desired.keys()]);
  for (const path of paths) {
    if (!current.has(path) || desired.has(path)) continue;
    const target = await safeDestination(root, path, false);
    let info;
    try { info = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`Unsafe sync destination: ${path}`);
    if (info) await unlink(target);
    let parent = dirname(target);
    while (parent !== root && parent.startsWith(`${root}${sep}`)) {
      try { await rmdir(parent); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; else break; }
      parent = dirname(parent);
    }
  }
  for (const path of paths) {
    const entry = desired.get(path);
    if (!entry || same(current.get(path), entry)) continue;
    const target = await safeDestination(root, path, true);
    let info;
    try { info = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`Unsafe sync destination: ${path}`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, entry.data, { mode: entry.executable ? 0o700 : 0o600, flag: 'wx' });
      await chmod(temporary, entry.executable ? 0o700 : 0o600);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

function reconcile(local, remote, baseline, unsafeLocal) {
  const paths = new Set([...local.keys(), ...remote.keys(), ...(baseline?.keys() || [])]);
  const merged = new Map();
  const conflicts = [];
  for (const path of paths) {
    if (unsafeLocal.has(path) && (baseline?.has(path) || remote.has(path))) {
      conflicts.push(path);
      continue;
    }
    const localFile = local.get(path);
    const remoteFile = remote.get(path);
    const baseFile = baseline?.get(path);
    if (!baseline) {
      if (localFile && remoteFile && !same(localFile, remoteFile)) conflicts.push(path);
      else if (localFile || remoteFile) merged.set(path, localFile || remoteFile);
      continue;
    }
    const localChanged = !same(localFile, baseFile);
    const remoteChanged = !same(remoteFile, baseFile);
    if (localChanged && remoteChanged && !same(localFile, remoteFile)) {
      conflicts.push(path);
    } else {
      const chosen = localChanged ? localFile : remoteChanged ? remoteFile : baseFile;
      if (chosen) merged.set(path, chosen);
    }
  }
  for (const path of merged.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (merged.has(parent)) conflicts.push(parent, path);
    }
  }
  if (conflicts.length) throw new Error(`Sync conflicts require manual resolution: ${[...new Set(conflicts)].sort().join(', ')}`);
  return merged;
}

export async function syncGitHubSnapshot({ directory = join(homedir(), '.friday'), snapshotName = basename(directory), owner, repo, managedRepos = [], stateFile, git = 'git', gh = 'gh', backend } = {}) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(snapshotName) || snapshotName === '.' || snapshotName === '..') throw new Error('Invalid agent snapshot directory');
  const source = resolve(directory);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Sync source must be a real directory');
  validTarget(owner, repo);
  const run = backend?.run || ((command, args, options) => exec(command, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0' }, ...options }));
  async function checkPrivate() {
    const { stdout } = await run(gh, ['repo', 'view', `${owner}/${repo}`, '--json', 'nameWithOwner,isPrivate'], { windowsHide: true });
    const details = JSON.parse(stdout);
    if (details.isPrivate !== true || details.nameWithOwner?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error('Configured GitHub repository must be private');
  }
  async function ensurePrivate() {
    try { await checkPrivate(); } catch (error) {
      const message = String(error.stderr || error.message || '');
      if (!/Could not resolve to a Repository with the name|HTTP 404/i.test(message)) throw error;
      await run(gh, ['repo', 'create', `${owner}/${repo}`, '--private'], { windowsHide: true });
      await checkPrivate();
    }
  }
  const temporary = await mkdtemp(join(tmpdir(), 'friday-github-sync-'));
  try {
    if (!backend) {
      await run(gh, ['auth', 'status', '--hostname', 'github.com'], { windowsHide: true });
      await ensurePrivate();
      await run(gh, ['repo', 'clone', `${owner}/${repo}`, join(temporary, 'repo'), '--', '--depth=1'], { windowsHide: true });
    } else {
      const checked = await backend.validate?.({ owner, repo });
      if (checked === false) throw new Error('Configured GitHub repository validation failed');
      await backend.prepare?.({ owner, repo, path: join(temporary, 'repo') });
    }
    const target = join(temporary, 'repo');
    await mkdir(target, { recursive: true });
    const snapshot = join(target, snapshotName);
    let snapshotInfo;
    try { snapshotInfo = await lstat(snapshot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (snapshotInfo && (snapshotInfo.isSymbolicLink() || !snapshotInfo.isDirectory())) throw new Error('Remote snapshot path is not a regular directory');
    if (!snapshotInfo) await mkdir(snapshot);

    const localExclusions = [...managedRepos, ...(stateFile ? [stateFile] : [])];
    const [localScan, remoteScan, baseline] = await Promise.all([
      scanTree(source, { excluded: localExclusions }),
      scanTree(snapshot, { rejectSymlinks: true }),
      readBaseline(stateFile, owner, repo),
    ]);
    const merged = reconcile(localScan.files, remoteScan.files, baseline, localScan.unsafe);
    const pulled = [...merged].filter(([path, file]) => !same(localScan.files.get(path), file) && same(remoteScan.files.get(path), file)).length;
    // Detect edits made while the remote copy was being prepared before applying pulled changes.
    const latestLocal = await scanTree(source, { excluded: localExclusions });
    for (const path of new Set([...localScan.files.keys(), ...latestLocal.files.keys()])) {
      if (!same(localScan.files.get(path), latestLocal.files.get(path))) throw new Error(`Local file changed during sync: ${path}`);
    }
    await applyTreeChanges(source, localScan.files, merged);
    await applyTreeChanges(snapshot, remoteScan.files, merged);

    if (backend) {
      const result = await (backend.commitAndPush?.({ path: target, owner, repo, copied: merged.size }) ?? { changed: false, pushed: false, copied: merged.size });
      await writeBaseline(stateFile, owner, repo, merged);
      return { ...result, pulled };
    }
    await run(git, ['-C', target, 'add', '-A'], { windowsHide: true });
    const { stdout: status } = await run(git, ['-C', target, 'status', '--porcelain'], { windowsHide: true });
    let changed = false;
    let pushed = false;
    if (status.trim()) {
      await run(git, ['-C', target, '-c', 'user.name=Friday snapshot', '-c', 'user.email=friday-snapshot@users.noreply.github.com', 'commit', '-m', 'Sync Friday snapshot'], { windowsHide: true });
      await checkPrivate();
      await run(git, ['-C', target, 'push', 'origin', 'HEAD'], { windowsHide: true });
      changed = true;
      pushed = true;
    }
    await writeBaseline(stateFile, owner, repo, merged);
    return { changed, pushed, copied: merged.size, pulled };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export { validTarget as validateGitHubSyncTarget };
