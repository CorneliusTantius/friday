import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseNotes, readNote } from '../src/storage/notes.js';

test('browse and read notes safely within the notes root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-notes-'));
  const outside = await mkdtemp(join(tmpdir(), 'friday-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'a.md'), '# A\n');
  await writeFile(join(root, 'nested', 'b.MD'), '# B\n');
  await writeFile(join(root, 'ignore.txt'), 'no');
  await writeFile(join(outside, 'secret.md'), 'secret');
  await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));
  assert.deepEqual(await browseNotes({ root }), ['a.md', 'nested/b.MD']);
  assert.equal(await readNote('nested/b.MD', { root }), '# B\n');
  for (const bad of ['../secret.md', 'ignore.txt', 'escape.md', '/etc/passwd', '']) {
    assert.equal(await readNote(bad, { root }), null);
  }
  assert.equal(await readNote('a.md', { root, maxBytes: 1 }), null);
});

test('missing notes root returns an empty listing', async () => {
  assert.deepEqual(await browseNotes({ root: join(tmpdir(), 'no-such-friday-notes') }), []);
});
