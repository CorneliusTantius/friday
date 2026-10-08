import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createPiRunRegistry } from '../src/pi/pi-run-registry.js';
import { createPiTaskReviewQueue } from '../src/friday/pi-task-review-queue.js';
import { createPiTaskCompletionHandler } from '../src/friday/pi-task-completion.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-task-completion-'));
  const registry = createPiRunRegistry({ file: path.join(dir, 'registry.json') });
  const runId = await registry.ensureRun({ workspace: dir, sessionPath: path.join(dir, 'session.jsonl'), sessionId: 'pi-session', name: 'Build task' });
  const task = await registry.createTask({ conversationId: 'friday-conversation', runId, queueId: '123e4567-e89b-42d3-a456-426614174001', label: 'Implement the task' });
  return { dir, registry, task };
}

test('terminal Pi success triggers an exact-task review, persists its report, and ignores duplicate events', async (t) => {
  const { dir, registry, task } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let reviews = 0;
  const audit = [];
  const reviewQueue = createPiTaskReviewQueue({ review: async (job, event) => {
    reviews += 1;
    assert.equal(job.id, task.id);
    assert.equal(event.status, 'completed');
    assert.equal((await registry.getTask(job.id)).status, 'reviewing', 'Pi success alone is not final');
    await registry.updateTask(job.id, { status: 'completed', summary: 'Verified the requested behavior and tests.', review: { stage: 'finished', finishedAt: new Date().toISOString() } });
  } });
  const completion = createPiTaskCompletionHandler({ registry, reviewQueue, audit: (event, details) => audit.push({ event, ...details }) });
  await completion.handle(task.queueId, { id: task.queueId, status: 'completed', result: 'private transcript and API key sk-secret' });
  await reviewQueue.waitFor(task.conversationId);
  assert.equal((await registry.getTask(task.id)).status, 'completed');
  assert.equal((await registry.getTask(task.id)).summary, 'Verified the requested behavior and tests.');
  assert.equal((await registry.getTask(task.id)).review.stage, 'finished');
  assert.ok(audit.some(({ event, taskId, runId, queueId }) => event === 'completion_received' && taskId === task.id && runId === task.runId && queueId === task.queueId));
  assert.ok(audit.some(({ event, stage }) => event === 'review_queued' && stage === 'queued'));
  assert.doesNotMatch(JSON.stringify(audit), /private transcript|sk-secret/);
  await completion.handle(task.queueId, { id: task.queueId, status: 'completed', result: 'duplicate' });
  await yieldTurn();
  assert.equal(reviews, 1, 'duplicate terminal events do not start another review');
});

test('duplicate terminal event cannot turn an active review back into queued state', async (t) => {
  const { dir, registry, task } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let release;
  const reviewQueue = createPiTaskReviewQueue({ review: async () => new Promise((resolve) => { release = resolve; }) });
  const audit = [];
  const completion = createPiTaskCompletionHandler({ registry, reviewQueue, audit: (event, details) => audit.push({ event, ...details }) });
  await completion.handle(task.queueId, { id: task.queueId, status: 'completed' });
  await yieldTurn();
  const activeReview = await registry.updateTask(task.id, {
    status: 'reviewing', review: { stage: 'active', startedAt: new Date().toISOString() },
  });
  await completion.handle(task.queueId, { id: task.queueId, status: 'completed' });
  const saved = await registry.getTask(task.id);
  assert.equal(saved.review.stage, 'active');
  assert.equal(saved.review.startedAt, activeReview.review.startedAt);
  assert.ok(audit.some(({ event }) => event === 'completion_duplicate'));
  release();
  await reviewQueue.waitFor(task.conversationId);
});

test('full review queue blocks the task as unverified rather than leaving it reviewing', async (t) => {
  const { dir, registry, task } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const completion = createPiTaskCompletionHandler({
    registry,
    reviewQueue: { enqueue: () => 'full' },
  });
  await completion.handle(task.queueId, { id: task.queueId, status: 'completed' });
  const saved = await registry.getTask(task.id);
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.review.stage, 'queue-full');
  assert.equal(saved.review.errorCode, 'review_queue_full');
  assert.match(saved.detail, /remains unverified/);
});

test('busy review queue serializes same-conversation terminal events; unknown states remain outcome-unknown', async (t) => {
  const { dir, registry, task } = await setup();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const queueId2 = '123e4567-e89b-42d3-a456-426614174002';
  const second = await registry.createTask({ conversationId: task.conversationId, runId: task.runId, queueId: queueId2, label: 'Second task' });
  const unknown = await registry.createTask({ conversationId: task.conversationId, runId: task.runId, queueId: '123e4567-e89b-42d3-a456-426614174003', label: 'Unknown task' });
  let release;
  const started = [];
  const reviewQueue = createPiTaskReviewQueue({ review: async (job) => {
    started.push(job.id);
    if (job.id === task.id) await new Promise((resolve) => { release = resolve; });
    await registry.updateTask(job.id, { status: 'blocked', summary: 'Review could not verify acceptance.' });
  } });
  const completion = createPiTaskCompletionHandler({ registry, reviewQueue });
  await Promise.all([
    completion.handle(task.queueId, { id: task.queueId, status: 'completed' }),
    completion.handle(second.queueId, { id: second.queueId, status: 'failed', error: 'failure' }),
    completion.handle(unknown.queueId, { id: unknown.queueId, status: 'unexpected' }),
  ]);
  await yieldTurn();
  assert.deepEqual(started, [task.id]);
  assert.equal((await registry.getTask(task.id)).status, 'reviewing');
  release();
  await reviewQueue.waitFor(task.conversationId);
  assert.deepEqual(started, [task.id, second.id]);
  assert.equal((await registry.getTask(task.id)).status, 'blocked');
  assert.equal((await registry.getTask(second.id)).status, 'blocked');
  assert.equal((await registry.getTask(unknown.id)).status, 'outcome-unknown');
  assert.match((await registry.getTask(unknown.id)).detail, /did not retry/);
});
