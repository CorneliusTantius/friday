import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiRunRegistry } from '../src/pi-run-registry.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-registry-'));
  return { dir, file: path.join(dir, 'nested', 'registry.json') };
}

test('stable session IDs, metadata updates, and restart restore', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const id = await registry.ensureRun({ workspace: '/work', sessionPath: '/trusted/s.json', sessionId: 's1', name: 'first' });
  assert.equal(await registry.ensureRun({ workspace: '/work2', sessionPath: '/trusted/s.json', sessionId: 's2', name: 'second' }), id);
  const restored = createPiRunRegistry({ file });
  assert.equal((await restored.getRun(id)).name, 'second');
  assert.equal((await restored.listRuns()).length, 1);
});

test('batch ensures preserve IDs and persist in one update', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const sessions = [
    { workspace: '/work', sessionPath: '/session/a', sessionId: 'a', name: 'A' },
    { workspace: '/work', sessionPath: '/session/b', sessionId: 'b', name: 'B' },
  ];
  const ids = await registry.ensureRuns(sessions);
  assert.deepEqual(await registry.ensureRuns(sessions), ids);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stored.runs.length, 2);
  assert.deepEqual(stored.runs.map(run => run.id), ids);
});

test('deleting a run removes its session mapping and Friday links', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const runId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/delete-me', sessionId: 'delete-me', name: 'Temporary' });
  const otherRunId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/keep', sessionId: 'keep', name: 'Keep' });
  await registry.linkConversation('friday-1', runId);
  await registry.linkConversation('friday-2', runId);
  assert.equal(await registry.deleteRun(runId), true);
  assert.equal(await registry.getRun(runId), null);
  assert.equal(await registry.getLinkedRun('friday-1'), null);
  assert.equal(await registry.getLinkedRun('friday-2'), null);
  assert.equal((await registry.getRun(otherRunId)).name, 'Keep');
  assert.notEqual(await registry.ensureRun({ workspace: '/work', sessionPath: '/session/delete-me', sessionId: 'delete-me', name: 'Recreated' }), runId);
});

test('conversation links, validation, concurrent mutations and restrictive modes', async () => {
  const { dir, file } = await setup();
  const registry = createPiRunRegistry({ file });
  const ids = await Promise.all(Array.from({ length: 24 }, (_, i) => registry.ensureRun({ sessionPath: `/session/${i}` })));
  await registry.linkConversation('conversation-1', ids[0]);
  assert.equal((await registry.getLinkedRun('conversation-1')).id, ids[0]);
  await registry.unlinkConversation('conversation-1');
  assert.equal(await registry.getLinkedRun('conversation-1'), null);
  assert.throws(() => registry.linkConversation('../bad', ids[0]), /Invalid conversation/);
  await assert.rejects(registry.getRun('../bad'), /Invalid run/);
  assert.equal((await registry.listRuns()).length, 24);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
