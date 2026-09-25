import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRepositoryStore } from '../src/repos.js';

test('repository listing reports branch and working tree stats', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'friday-git-stats-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repos = join(temp, 'repos');
  const repo = join(repos, 'sample');
  await mkdir(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'tracked'), 'original');
  git('add', 'tracked');
  git('commit', '-m', 'initial');
  await writeFile(join(repo, 'tracked'), 'staged');
  git('add', 'tracked');
  await writeFile(join(repo, 'tracked'), 'unstaged');
  await writeFile(join(repo, 'new-file'), 'new');

  const [result] = await createRepositoryStore({ directory: repos }).listRepositories();
  assert.equal(result.branch, 'main');
  assert.equal(result.staged, 1);
  assert.equal(result.unstaged, 1);
  assert.equal(result.untracked, 1);
  assert.equal(result.ahead, null);
  assert.equal(result.behind, null);
  assert.match(result.latestCommit, /^[0-9a-f]+$/);
});

test('managed repository store clones only safe URL-derived destinations and lists Git repositories', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'friday-repos-'));
  const git = join(temp, 'fake-git');
  const repos = join(temp, 'repos');
  await writeFile(git, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'clone' || args[1] !== '--') process.exit(2);
fs.mkdirSync(args[3], { recursive: true });
fs.mkdirSync(args[3] + '/.git');
` , { mode: 0o755 });
  t.after(() => rm(temp, { recursive: true, force: true }));
  const store = createRepositoryStore({ directory: repos, gitCommand: git });

  assert.deepEqual(await store.listRepositories(), []);
  assert.deepEqual(await store.cloneRepository('https://example.com/team/project.git'), {
    name: 'project', path: join(repos, 'project'),
  });
  assert.deepEqual(await store.listRepositories(), [{ name: 'project', path: join(repos, 'project'), branch: null, staged: null, unstaged: null, untracked: null, ahead: null, behind: null, latestCommit: null }]);
  await assert.rejects(store.cloneRepository('https://example.com/team/project.git'), /already exists/);
  await assert.rejects(store.cloneRepository('--upload-pack=evil'), /Git URL/);
  for (const unsafe of ['/tmp/project', 'file:///tmp/project', 'https://user@example.com/project', 'https://example.com/project?upload-pack=evil']) {
    await assert.rejects(store.cloneRepository(unsafe));
  }
  const concurrent = await Promise.allSettled([
    store.cloneRepository('https://example.com/team/race.git'),
    store.cloneRepository('https://example.com/other/race.git'),
  ]);
  assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(({ status }) => status === 'rejected').length, 1);
  const different = await Promise.allSettled([
    store.cloneRepository('https://example.com/team/alpha.git'),
    store.cloneRepository('https://example.com/team/beta.git'),
  ]);
  assert.equal(different.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.match(different.find(({ status }) => status === 'rejected').reason.message, /already in progress/);
  await mkdir(join(repos, 'not-a-repo'));
  assert.deepEqual((await store.listRepositories()).map(({ name }) => name), ['alpha', 'project', 'race']);
});

test('repository sync pulls all remotes only when the working tree is clean', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'friday-repo-pull-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const remote = join(temp, 'remote.git');
  const seed = join(temp, 'seed');
  const repos = join(temp, 'repos');
  const repo = join(repos, 'sample');
  const git = (...args) => execFileSync('git', args, { cwd: temp, stdio: 'ignore' });
  await mkdir(seed);
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '-b', 'main', seed);
  git('-C', seed, 'config', 'user.email', 'test@example.com');
  git('-C', seed, 'config', 'user.name', 'Test');
  await writeFile(join(seed, 'tracked'), 'initial');
  git('-C', seed, 'add', 'tracked');
  git('-C', seed, 'commit', '-m', 'initial');
  git('-C', seed, 'remote', 'add', 'origin', remote);
  git('-C', seed, 'push', '-u', 'origin', 'main');
  await mkdir(repos);
  git('clone', remote, repo);

  await writeFile(join(seed, 'tracked'), 'updated upstream');
  git('-C', seed, 'commit', '-am', 'upstream update');
  git('-C', seed, 'push');
  const store = createRepositoryStore({ directory: repos });
  const pulled = await store.pullRepository('sample');
  assert.equal(await readFile(join(repo, 'tracked'), 'utf8'), 'updated upstream');
  assert.equal(pulled.branch, 'main');
  assert.equal(pulled.staged, 0);
  assert.equal(pulled.unstaged, 0);
  assert.equal(pulled.untracked, 0);

  await writeFile(join(repo, 'untracked'), 'local change');
  await assert.rejects(store.pullRepository('sample'), { code: 'DIRTY' });
  await assert.rejects(store.pullRepository('../remote.git'), { code: 'INVALID' });
});
