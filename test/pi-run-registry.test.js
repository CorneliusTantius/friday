import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiRunRegistry } from '../src/pi/pi-run-registry.js';

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

test('renaming a run persists its new session name without losing metadata', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const runId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/rename', sessionId: 'rename-run', name: 'Build task', domain: 'platform', purpose: 'maintain platform' });
  const renamed = await registry.renameRun(runId, 'friday-ui');
  assert.equal(renamed.name, 'friday-ui');
  assert.equal(renamed.domain, 'platform');
  assert.equal(renamed.purpose, 'maintain platform');
  assert.equal((await createPiRunRegistry({ file }).getRun(runId)).name, 'friday-ui');
  assert.throws(() => registry.renameRun('../bad', 'name'), /Invalid run/);
  assert.throws(() => registry.renameRun(runId, '  '), /Invalid run name/);
});

test('closed marker persists as run state and renaming toggles it', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const runId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/closed', sessionId: 'closed-run', name: '[closed] friday' });
  assert.equal((await registry.getRun(runId)).closed, true);
  const restored = createPiRunRegistry({ file });
  assert.equal((await restored.getRun(runId)).closed, true);
  await restored.renameRun(runId, 'friday');
  assert.equal((await restored.getRun(runId)).closed, false);
  await restored.renameRun(runId, '[closed] friday');
  assert.equal((await restored.getRun(runId)).closed, true);
});

test('new runs default to two; legacy missing capacity stays unstored and configured capacity remains unchanged', async () => {
  const { file } = await setup();
  const legacyRunId = '123e4567-e89b-12d3-a456-426614174010';
  const configuredRunId = '123e4567-e89b-12d3-a456-426614174011';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    runs: [
      { id: legacyRunId, workspace: '/work', sessionPath: '/session/legacy', name: 'Legacy' },
      { id: configuredRunId, workspace: '/work', sessionPath: '/session/configured', name: 'Configured', capacity: 5 },
    ],
  }));
  const registry = createPiRunRegistry({ file });
  assert.equal((await registry.getRun(legacyRunId)).capacity, undefined);
  assert.equal((await registry.getRun(configuredRunId)).capacity, 5);
  const newlyRegistered = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/new', name: 'New' });
  assert.equal((await registry.getRun(newlyRegistered)).capacity, 2);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal('capacity' in persisted.runs.find(({ id }) => id === legacyRunId), false);
  assert.equal(persisted.runs.find(({ id }) => id === configuredRunId).capacity, 5);
});

test('repository visibility defaults to all, persists per run, and preserves staff profile metadata', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const firstRun = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/repo-a', sessionId: 'repo-a', name: 'Repo A' });
  const secondRun = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/repo-b', sessionId: 'repo-b', name: 'Repo B' });
  assert.equal((await registry.getRun(firstRun)).hiddenRepositories, undefined, 'legacy/unconfigured runs remain unstored and therefore default to all visible');
  const unconfigured = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(unconfigured.runs.every((run) => !Object.hasOwn(run, 'hiddenRepositories')), 'default listing does not rewrite a visibility value into old runs');
  await registry.updateRunProfile(firstRun, { expertise: ['Node'], responsibilities: ['API'], repositories: ['affinity-repo'], capacity: 2 });
  await registry.updateRunRepositoryVisibility(firstRun, ['hidden-repo']);

  const restored = createPiRunRegistry({ file });
  assert.deepEqual((await restored.getRun(firstRun)).hiddenRepositories, ['hidden-repo']);
  assert.deepEqual((await restored.getRun(firstRun)).repositories, ['affinity-repo'], 'visibility changes do not rewrite profile affinity');
  assert.equal((await restored.getRun(secondRun)).hiddenRepositories, undefined, 'visibility is isolated by run');
  await restored.updateRunRepositoryVisibility(firstRun, []);
  assert.deepEqual((await createPiRunRegistry({ file }).getRun(firstRun)).hiddenRepositories, [], 'rechecking all repos persists explicitly');
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

test('task state and session-fit metadata persist, and interrupted work becomes outcome-unknown', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const runId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/task', sessionId: 'task-run', name: 'Billing API', domain: 'billing', purpose: 'maintain the billing service' });
  const task = await registry.createTask({ conversationId: 'friday-task-1', runId, queueId: '123e4567-e89b-12d3-a456-426614174001', label: 'Add invoice export' });
  assert.equal((await registry.getCurrentTask('friday-task-1')).status, 'queued');
  await registry.updateTask(task.id, { status: 'reviewing', review: { stage: 'active', startedAt: '2026-10-08T09:00:00.000Z' } });
  const recoveries = [];
  const restored = createPiRunRegistry({ file, onRecovery: (recovery) => recoveries.push(recovery) });
  assert.equal((await restored.getRun(runId)).domain, 'billing');
  const interrupted = await restored.getTask(task.id);
  assert.equal(interrupted.status, 'outcome-unknown');
  assert.match(interrupted.detail, /restarted/);
  assert.equal(interrupted.review.stage, 'interrupted');
  assert.equal(interrupted.review.errorCode, 'process_restarted');
  assert.equal(recoveries[0].taskId, task.id);
  assert.equal(recoveries[0].runId, runId);
  assert.equal(recoveries[0].previousStatus, 'reviewing');
  assert.equal((await restored.getCurrentTask('friday-task-1')).id, task.id);
  await restored.clearCurrentTask('friday-task-1');
  assert.equal(await restored.getCurrentTask('friday-task-1'), null);
});

test('serialized cleanup backs up and clears only the exact stale detail on completed tasks', async (t) => {
  const { dir, file } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = createPiRunRegistry({ file });
  const runId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/cleanup', sessionId: 'cleanup-run', name: 'Cleanup test' });
  const create = (label) => registry.createTask({ conversationId: 'cleanup-conversation', runId, label });
  const completed = await create('completed stale');
  await registry.updateTask(completed.id, { status: 'running' });
  await registry.updateTask(completed.id, { status: 'reviewing' });
  await registry.updateTask(completed.id, { status: 'completed', summary: 'Verified result.' });
  const stale = 'Pi finished; Friday is checking the result against the original request.';
  await registry.updateTask(completed.id, { status: 'completed', detail: stale });
  const completedDifferent = await create('completed different');
  await registry.updateTask(completedDifferent.id, { status: 'running' });
  await registry.updateTask(completedDifferent.id, { status: 'reviewing' });
  await registry.updateTask(completedDifferent.id, { status: 'completed', summary: 'Keep this summary.' });
  await registry.updateTask(completedDifferent.id, { status: 'completed', detail: 'Other detail.' });
  const blocked = await create('blocked');
  await registry.updateTask(blocked.id, { status: 'blocked', detail: stale });
  const running = await create('running');
  await registry.updateTask(running.id, { status: 'running', detail: stale });
  const queued = await create('queued');
  await registry.updateTask(queued.id, { status: 'queued', detail: stale });
  const before = JSON.parse(await fs.readFile(file, 'utf8'));
  const backupFile = path.join(dir, 'registry.backup.json');

  const result = await registry.clearStaleCompletedReviewDetails(backupFile);

  assert.deepEqual(result, { count: 1, taskIds: [completed.id], backupFile });
  assert.deepEqual(JSON.parse(await fs.readFile(backupFile, 'utf8')), before);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const expected = structuredClone(before);
  delete expected.tasks.find((task) => task.id === completed.id).detail;
  assert.deepEqual(saved, expected);
  const tasks = new Map(saved.tasks.map((task) => [task.id, task]));
  const originalCompleted = before.tasks.find((task) => task.id === completed.id);
  assert.equal(tasks.get(completed.id).detail, undefined);
  assert.equal(tasks.get(completed.id).status, originalCompleted.status);
  assert.equal(tasks.get(completed.id).summary, originalCompleted.summary);
  assert.equal(tasks.get(completed.id).updatedAt, originalCompleted.updatedAt);
  assert.equal(tasks.get(completedDifferent.id).detail, 'Other detail.');
  assert.equal(tasks.get(completedDifferent.id).summary, 'Keep this summary.');
  assert.equal(tasks.get(blocked.id).detail, stale);
  assert.equal(tasks.get(running.id).status, 'running');
  assert.equal(tasks.get(running.id).detail, stale);
  assert.equal(tasks.get(queued.id).status, 'queued');
  assert.equal(tasks.get(queued.id).detail, stale);
});

test('cleanup refuses to overwrite registry data changed outside this process', async (t) => {
  const { dir, file } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = createPiRunRegistry({ file });
  const runId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/concurrent-cleanup', name: 'Concurrent cleanup' });
  const task = await registry.createTask({ conversationId: 'concurrent-cleanup', runId, label: 'Task' });
  await registry.updateTask(task.id, { status: 'running' });
  await registry.updateTask(task.id, { status: 'reviewing' });
  await registry.updateTask(task.id, { status: 'completed', detail: 'Pi finished; Friday is checking the result against the original request.' });
  const external = JSON.parse(await fs.readFile(file, 'utf8'));
  external.tasks[0].summary = 'Concurrent update';
  const externalContents = JSON.stringify(external);
  await fs.writeFile(file, externalContents);
  const backupFile = path.join(dir, 'must-not-create.json');

  await assert.rejects(registry.clearStaleCompletedReviewDetails(backupFile), /Registry changed outside this process/);
  assert.equal(await fs.readFile(file, 'utf8'), externalContents);
  await assert.rejects(fs.access(backupFile), { code: 'ENOENT' });
});

test('delegated task state transitions persist with status-safe summaries', async () => {
  const { file } = await setup();
  const registry = createPiRunRegistry({ file });
  const runId = await registry.ensureRun({ workspace: '/work', sessionPath: '/session/report', sessionId: 'report-run' });
  const queueId = '123e4567-e89b-12d3-a456-426614174002';
  const task = await registry.createTask({ conversationId: 'friday-task-2', runId, queueId, label: 'Run tests' });
  await registry.updateTask(task.id, { status: 'running' });
  await registry.updateTask(task.id, { status: 'reviewing', detail: 'Pi finished; Friday is checking the result against the original request.' });
  await registry.updateTask(task.id, { status: 'completed', summary: 'Tests passed.' });
  const reported = await registry.getTaskForPrompt(runId, queueId);
  assert.equal(reported.status, 'completed');
  assert.equal(reported.summary, 'Tests passed.');
  assert.equal('detail' in reported, false, 'final summary must not retain stale in-progress detail');
  assert.equal('prompt' in reported, false);
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
