import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function repositoryName(url) {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048 || /[\0\r\n]/.test(url)) {
    throw new Error('A valid Git URL is required');
  }
  const value = url.trim();
  let path;
  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value) || /^git:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('Unsupported Git URL'); }
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Unsupported Git URL');
    }
    path = parsed.pathname;
  } else if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(value)) {
    path = value.slice(value.indexOf(':') + 1);
  } else {
    throw new Error('Git URL must use HTTPS, SSH, or Git protocol');
  }
  const name = basename(path.replace(/\/+$/, '')).replace(/\.git$/i, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name) || name === '.' || name === '..') {
    throw new Error('Could not determine a safe repository name');
  }
  return name;
}

export function createRepositoryStore({ directory = join(homedir(), '.friday', 'repos'), gitCommand = 'git' } = {}) {
  const root = resolve(directory);
  let cloning = false;
  const pulling = new Set();

  async function repositoryStats(path) {
    const unavailable = { branch: null, staged: null, unstaged: null, untracked: null, ahead: null, behind: null, latestCommit: null };
    try {
      const { stdout } = await execFileAsync(gitCommand, ['-C', path, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'], { timeout: 5000, maxBuffer: 1024 * 1024 });
      const lines = stdout.split('\n');
      const header = lines.shift() || '';
      const branchMatch = header.match(/^## (.+?)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?$/);
      const stats = { ...unavailable };
      if (branchMatch) {
        stats.branch = branchMatch[1] === 'HEAD (no branch)' ? 'Detached HEAD' : branchMatch[1].replace(/^No commits yet on /, '') || null;
        if (branchMatch[3] !== undefined) stats.ahead = Number(branchMatch[3]);
        if (branchMatch[4] !== undefined) stats.behind = Number(branchMatch[4]);
      }
      stats.staged = 0;
      stats.unstaged = 0;
      stats.untracked = 0;
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('??')) { stats.untracked++; continue; }
        if (line[0] !== ' ' && line[0] !== '?') stats.staged++;
        if (line[1] !== ' ' && line[1] !== '?') stats.unstaged++;
      }
      try {
        const { stdout: hash } = await execFileAsync(gitCommand, ['-C', path, 'rev-parse', '--short', 'HEAD'], { timeout: 5000, maxBuffer: 1024 * 1024 });
        stats.latestCommit = hash.trim() || null;
      } catch {}
      return stats;
    } catch {
      return unavailable;
    }
  }

  async function listRepositories() {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const repositories = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      try {
        const resolved = await realpath(path);
        if (resolved !== root && !resolved.startsWith(root + '/') ) continue;
        const marker = await lstat(join(path, '.git'));
        if (marker.isDirectory() || marker.isFile()) repositories.push({ name: entry.name, path, ...await repositoryStats(path) });
      } catch {}
    }
    return repositories.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function pullRepository(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      const error = new Error('A valid managed repository name is required');
      error.code = 'INVALID';
      throw error;
    }
    const path = join(root, name);
    const key = resolve(path);
    if (pulling.has(key)) {
      const error = new Error('A pull is already in progress for this repository');
      error.code = 'BUSY';
      throw error;
    }
    pulling.add(key);
    try {
      const [rootPath, repoPath, entry, marker] = await Promise.all([
        realpath(root), realpath(path), lstat(path), lstat(join(path, '.git')),
      ]);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !repoPath.startsWith(rootPath + sep) || (!marker.isDirectory() && !marker.isFile())) {
        throw new Error('Repository is not inside the managed repository directory');
      }
      const { stdout: changes } = await execFileAsync(gitCommand, ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=all'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      if (changes.trim()) {
        const error = new Error('Repository has uncommitted changes; commit, discard, or stash them before syncing.');
        error.code = 'DIRTY';
        throw error;
      }
      try {
        await execFileAsync(gitCommand, ['-C', repoPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5_000, maxBuffer: 64 * 1024 });
      } catch {
        throw new Error('Cannot sync while HEAD is detached. Check out a branch first.');
      }
      try {
        await execFileAsync(gitCommand, ['-C', repoPath, 'pull', '--all'], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
      } catch {
        throw new Error('Git pull failed; check the remote, credentials, and branch upstream.');
      }
      return { name, ...await repositoryStats(repoPath) };
    } finally {
      pulling.delete(key);
    }
  }

  async function cloneRepository(url) {
    const name = repositoryName(url);
    if (cloning) throw new Error('A repository clone is already in progress');
    cloning = true;
    try {
      await mkdir(root, { recursive: true });
      const destination = join(root, name);
      try {
        await mkdir(destination);
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Repository already exists: ${name}`);
        throw error;
      }
      const reservation = await lstat(destination);
      try {
        await execFileAsync(gitCommand, ['clone', '--', url.trim(), destination], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
        const [resolved, current] = await Promise.all([realpath(destination), lstat(destination)]);
        if (current.dev !== reservation.dev || current.ino !== reservation.ino || !resolved.startsWith(root + '/')) {
          throw new Error('Clone destination escaped managed repository directory');
        }
        return { name, path: destination };
      } catch (error) {
        try {
          const current = await lstat(destination);
          if (current.dev === reservation.dev && current.ino === reservation.ino) {
            await rm(destination, { recursive: true, force: true });
          }
        } catch {}
        throw error;
      }
    } finally {
      cloning = false;
    }
  }

  return { directory: root, listRepositories, pullRepository, cloneRepository };
}

export { repositoryName };
