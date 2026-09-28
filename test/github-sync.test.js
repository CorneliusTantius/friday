import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, cp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncGitHubSnapshot, validateGitHubSyncTarget } from '../src/github-sync.js';

test('sync includes settings, credentials, sessions and binary data, excluding only repos, node_modules and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-test-'));
  const source = join(root, 'source');
  const repo = join(source, 'project');
  try {
    await mkdir(repo, { recursive: true });
    await writeFile(join(source, 'notes.md'), 'safe note');
    await writeFile(join(repo, 'tracked.txt'), 'managed repo');
    await writeFile(join(source, 'auth.json'), '{"token":"provider-secret"}');
    await writeFile(join(source, 'settings.json'), '{"private":true}');
    await writeFile(join(source, 'models.json'), '{"models":[]}');
    await writeFile(join(source, '.env'), 'SECRET=abc');
    await mkdir(join(source, 'repos'));
    await writeFile(join(source, 'repos', 'tracked.txt'), 'must not sync');
    await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, 'node_modules', 'package.js'), 'must not sync');
    await mkdir(join(source, 'sessions'));
    await writeFile(join(source, 'sessions', 'conversation.jsonl'), 'private conversation');
    await mkdir(join(source, 'memory'));
    await writeFile(join(source, 'memory', 'context.bin'), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(source, 'large.dat'), Buffer.alloc(2 * 1024 * 1024 + 1, 7));
    const { symlink } = await import('node:fs/promises');
    await writeFile(join(root, 'outside'), 'outside source');
    await symlink(join(root, 'outside'), join(source, 'outside-link'));
    await symlink(join(root, 'outside-dir'), join(source, 'linked-dir'));
    const result = await syncGitHubSnapshot({ directory: source, owner: 'me', repo: 'private', managedRepos: [repo], backend: {
      validate: async ({ owner, repo: name }) => owner === 'me' && name === 'private',
      prepare: async ({ path }) => { await mkdir(path, { recursive: true }); await writeFile(join(path, 'old.txt'), 'old'); },
      commitAndPush: async ({ path, copied }) => {
        assert.equal(copied, 8);
        for (const file of ['auth.json', 'settings.json', 'models.json', 'sessions/conversation.jsonl', 'memory/context.bin', 'large.dat']) {
          assert.deepEqual(await readFile(join(path, 'source', file)), await readFile(join(source, file)));
        }
        assert.equal(await readFile(join(path, 'old.txt'), 'utf8'), 'old');
        for (const file of ['repos', 'node_modules', 'project', 'linked-dir', 'outside-link']) await assert.rejects(lstat(join(path, 'source', file)));
        return { changed: true, pushed: false, copied };
      }
    } });
    assert.deepEqual(result, { changed: true, pushed: false, copied: 8, pulled: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sync fails closed when destination privacy cannot be verified', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(syncGitHubSnapshot({ directory: root, owner: 'me', repo: 'public', backend: { validate: async () => false } }), /validation failed/);
});

test('target validation rejects malformed repository names', () => {
  assert.throws(() => validateGitHubSyncTarget('owner', '../repo'));
  assert.throws(() => validateGitHubSyncTarget('bad owner', 'private'));
});

test('sync pushes a scoped snapshot without deleting unrelated private-repo files', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const git = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'github-sync-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const source = join(root, '.friday');
  await mkdir(source);
  await mkdir(seed);
  await git('git', ['init', '--bare', '--initial-branch=main', remote]);
  await git('git', ['init', '-b', 'main', seed]);
  await writeFile(join(seed, 'README.md'), 'keep me');
  await git('git', ['-C', seed, 'add', '.']);
  await git('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed']);
  await git('git', ['-C', seed, 'remote', 'add', 'origin', remote]);
  await git('git', ['-C', seed, 'push', 'origin', 'main']);
  await writeFile(join(source, 'note.md'), 'safe note');
  const fakeGh = join(root, 'gh');
  await writeFile(fakeGh, `#!/bin/sh\ncase "$1 $2" in\n  "auth status") exit 0 ;;\n  "repo view") printf '%s\\n' '{"nameWithOwner":"me/private","isPrivate":true}' ;;\n  "repo clone") exec git clone '${remote}' "$4" ;;\n  *) exit 2 ;;\nesac\n`, { mode: 0o755 });
  const options = { directory: source, owner: 'me', repo: 'private', gh: fakeGh };
  assert.deepEqual(await syncGitHubSnapshot(options), { changed: true, pushed: true, copied: 1, pulled: 0 });
  const checkout = join(root, 'checkout');
  await git('git', ['clone', remote, checkout]);
  assert.equal(await readFile(join(checkout, 'README.md'), 'utf8'), 'keep me');
  assert.equal(await readFile(join(checkout, '.friday', 'note.md'), 'utf8'), 'safe note');
  assert.deepEqual(await syncGitHubSnapshot(options), { changed: false, pushed: false, copied: 1, pulled: 0 });
});

test('sync pulls remote changes, pushes local changes, and merges distinct paths using its baseline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const remote = join(root, 'remote', '.friday');
  const stateFile = join(root, 'state', 'baseline.json');
  await mkdir(source, { recursive: true });
  await mkdir(remote, { recursive: true });
  await writeFile(join(source, 'shared.txt'), 'base');
  await writeFile(join(remote, 'shared.txt'), 'base');
  await writeFile(join(remote, 'remote-only.txt'), 'remote v1');
  let pushed = 0;
  const backend = {
    validate: async () => true,
    prepare: async ({ path }) => {
      await mkdir(path, { recursive: true });
      await cp(remote, join(path, '.friday'), { recursive: true });
    },
    commitAndPush: async ({ path }) => {
      await rm(join(root, 'remote'), { recursive: true, force: true });
      await cp(path, join(root, 'remote'), { recursive: true });
      pushed += 1;
      return { changed: true, pushed: true };
    },
  };
  const options = { directory: source, snapshotName: '.friday', owner: 'me', repo: 'private', stateFile, backend };

  const initial = await syncGitHubSnapshot(options);
  assert.equal(initial.pulled, 1);
  assert.equal(await readFile(join(source, 'remote-only.txt'), 'utf8'), 'remote v1');

  await writeFile(join(source, 'local-only.txt'), 'local v1');
  await writeFile(join(remote, 'remote-only.txt'), 'remote v2');
  await syncGitHubSnapshot(options);
  assert.equal(await readFile(join(remote, 'local-only.txt'), 'utf8'), 'local v1');
  assert.equal(await readFile(join(source, 'remote-only.txt'), 'utf8'), 'remote v2');
  assert.equal(await readFile(join(remote, 'remote-only.txt'), 'utf8'), 'remote v2');
  assert.equal(pushed, 2);
});

test('sync propagates deletions and rejects same-file conflicts without overwriting either side', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const remote = join(root, 'remote', '.friday');
  const stateFile = join(root, 'state', 'baseline.json');
  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'remote'), { recursive: true });
  await writeFile(join(source, 'shared.txt'), 'base');
  await writeFile(join(source, 'delete-me.txt'), 'base delete');
  await cp(source, remote, { recursive: true });
  const backend = {
    validate: async () => true,
    prepare: async ({ path }) => { await mkdir(path, { recursive: true }); await cp(remote, join(path, '.friday'), { recursive: true }); },
    commitAndPush: async ({ path }) => {
      await rm(join(root, 'remote'), { recursive: true, force: true });
      await cp(path, join(root, 'remote'), { recursive: true });
      return { changed: true, pushed: true };
    },
  };
  const options = { directory: source, snapshotName: '.friday', owner: 'me', repo: 'private', stateFile, backend };
  await syncGitHubSnapshot(options);

  await unlink(join(source, 'delete-me.txt'));
  await syncGitHubSnapshot(options);
  await assert.rejects(readFile(join(remote, 'delete-me.txt')));

  await writeFile(join(source, 'shared.txt'), 'local edit');
  await writeFile(join(remote, 'shared.txt'), 'remote edit');
  await assert.rejects(syncGitHubSnapshot(options), /Sync conflicts require manual resolution: shared.txt/);
  assert.equal(await readFile(join(source, 'shared.txt'), 'utf8'), 'local edit');
  assert.equal(await readFile(join(remote, 'shared.txt'), 'utf8'), 'remote edit');
});

test('sync does not advance its baseline when pushing fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'github-sync-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'local.txt'), 'local');
  const stateFile = join(root, 'state', 'baseline.json');
  const backend = {
    validate: async () => true,
    prepare: async ({ path }) => mkdir(path, { recursive: true }),
    commitAndPush: async () => { throw new Error('push failed'); },
  };
  await assert.rejects(syncGitHubSnapshot({ directory: source, owner: 'me', repo: 'private', stateFile, backend }), /push failed/);
  await assert.rejects(readFile(stateFile));
});

test('sync creates a missing target as private before pushing the snapshot', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const git = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'github-sync-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'new-private.git');
  const marker = join(root, 'created');
  const source = join(root, '.pi');
  await mkdir(source);
  await writeFile(join(source, 'note.md'), 'Pi snapshot');
  const fakeGh = join(root, 'gh');
  await writeFile(fakeGh, `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view")
    if [ ! -e '${marker}' ]; then echo "GraphQL: Could not resolve to a Repository with the name 'me/new-private'. (repository)" >&2; exit 1; fi
    printf '%s\\n' '{"nameWithOwner":"me/new-private","isPrivate":true}' ;;
  "repo create")
    [ "$3" = 'me/new-private' ] && [ "$4" = '--private' ] || exit 3
    git init --bare '${remote}' >/dev/null && touch '${marker}' ;;
  "repo clone") exec git clone '${remote}' "$4" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  const result = await syncGitHubSnapshot({ directory: source, owner: 'me', repo: 'new-private', snapshotName: '.pi', gh: fakeGh });
  assert.deepEqual(result, { changed: true, pushed: true, copied: 1, pulled: 0 });
  assert.equal((await lstat(marker)).isFile(), true);
  const checkout = join(root, 'checkout');
  await git('git', ['clone', remote, checkout]);
  assert.equal(await readFile(join(checkout, '.pi', 'note.md'), 'utf8'), 'Pi snapshot');
});
