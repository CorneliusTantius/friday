import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { mkdtemp, readdir, lstat, open, writeFile, mkdir, rm } from 'node:fs/promises';

const exec = promisify(execFile);
const forbiddenDirectories = new Set(['repos', 'node_modules']);

function validTarget(owner, repo) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner || '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo || '') || repo === '.' || repo === '..') throw new Error('A valid configured GitHub owner and repository are required');
}

export async function syncGitHubSnapshot({ directory = join(homedir(), '.friday'), snapshotName = basename(directory), owner, repo, managedRepos = [], git = 'git', gh = 'gh', backend } = {}) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(snapshotName) || snapshotName === '.' || snapshotName === '..') throw new Error('Invalid agent snapshot directory');
  const source = resolve(directory);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Sync source must be a real directory');
  validTarget(owner, repo);
  const run = backend?.run || ((command, args, options) => exec(command, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0' }, ...options }));
  async function checkPrivate() {
    const { stdout } = await run(gh, ['repo', 'view', `${owner}/${repo}`, '--json', 'nameWithOwner,isPrivate'], { windowsHide: true });
    const details = JSON.parse(stdout);
    if (details.isPrivate !== true || details.nameWithOwner?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      throw new Error('Configured GitHub repository must be private');
    }
  }
  async function ensurePrivate() {
    try {
      await checkPrivate();
    } catch (error) {
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
    const excluded = managedRepos.map(path => resolve(path));
    let copied = 0;
    async function walk(from, to) {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const src = join(from, entry.name), dest = join(to, entry.name);
        const abs = resolve(src);
        if (excluded.some(p => abs === p || abs.startsWith(p + sep)) || entry.name === '.git' || (entry.isDirectory() && forbiddenDirectories.has(entry.name))) continue;
        const stat = await lstat(src);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) { await mkdir(dest, { recursive: true }); await walk(src, dest); continue; }
        if (!stat.isFile()) continue;
        const file = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data;
        try {
          const opened = await file.stat();
          if (!opened.isFile()) continue;
          data = await file.readFile();
        } finally { await file.close(); }
        await mkdir(to, { recursive: true }); await writeFile(dest, data, { mode: stat.mode & 0o111 ? 0o700 : 0o600 }); copied++;
      }
    }
    // Replace only this agent's snapshot; leave other repository contents untouched.
    await rm(snapshot, { recursive: true, force: true });
    await mkdir(snapshot);
    await walk(source, snapshot);
    if (backend) return await (backend.commitAndPush?.({ path: target, owner, repo, copied }) ?? { changed: copied > 0, pushed: false, copied });
    await run(git, ['-C', target, 'add', '-A'], { windowsHide: true });
    const { stdout: status } = await run(git, ['-C', target, 'status', '--porcelain'], { windowsHide: true });
    if (!status.trim()) return { changed: false, pushed: false, copied };
    await run(git, ['-C', target, '-c', 'user.name=Friday snapshot', '-c', 'user.email=friday-snapshot@users.noreply.github.com', 'commit', '-m', 'Update Friday snapshot'], { windowsHide: true });
    await checkPrivate();
    await run(git, ['-C', target, 'push', 'origin', 'HEAD'], { windowsHide: true });
    return { changed: true, pushed: true, copied };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export { validTarget as validateGitHubSyncTarget };
