import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgentFiles, readAgentFile } from '../src/agent-files.js';

test('scoped agent roots list and preview safe files only', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agent-files-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const friday = join(home, '.friday');
  await mkdir(join(friday, 'nested'), { recursive: true });
  await writeFile(join(friday, 'nested', 'notes.md'), 'hello');
  await writeFile(join(friday, 'auth.json'), '{"token":"secret"}');
  await mkdir(join(friday, 'config'));
  await writeFile(join(friday, 'config', 'auth.json'), '{"key":"secret"}');
  await writeFile(join(friday, 'config', 'settings.json'), '{"model":"safe"}');
  await writeFile(join(friday, '.hidden'), 'hidden');
  await writeFile(join(friday, 'binary'), Buffer.from([0, 1]));
  await symlink(home, join(friday, 'escape'));
  const listing = await listAgentFiles({ root: 'friday', home });
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['config', 'nested', 'binary']);
  const configFiles = await listAgentFiles({ root: 'friday', path: 'config', home });
  assert.deepEqual(configFiles.entries, []);
  assert.deepEqual(Object.keys(listing), ['root', 'directory', 'path', 'entries']);
  assert.equal(listing.directory, friday);
  assert.equal(listing.entries[0].workspacePath, null);
  assert.equal((await readAgentFile({ root: 'friday', path: 'nested/notes.md', home })).content, 'hello');
  await assert.rejects(readAgentFile({ root: 'friday', path: 'auth.json', home }));
  await assert.rejects(readAgentFile({ root: 'friday', path: 'config/auth.json', home }));
  await assert.rejects(readAgentFile({ root: 'friday', path: 'config/settings.json', home }));
  await assert.rejects(readAgentFile({ root: 'friday', path: 'binary', home }), /binary/);
  await assert.rejects(listAgentFiles({ root: 'friday', path: '../', home }));
  await assert.rejects(listAgentFiles({ root: 'friday', path: 'escape', home }));
});

test('Pi root honors PI_CODING_AGENT_DIR parent', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agent-pi-'));
  const parent = join(home, 'custom');
  await mkdir(join(parent, 'agent'), { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const data = await listAgentFiles({ root: 'pi', home, env: { PI_CODING_AGENT_DIR: join(parent, 'agent') } });
  assert.equal(data.root, 'pi');
  assert.deepEqual(data.entries.map((entry) => entry.name), ['agent']);
});
