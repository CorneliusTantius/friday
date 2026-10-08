import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createPiTaskReviewQueue } from '../src/friday/pi-task-review-queue.js';

function task(id, conversationId = 'origin') {
  return { id, runId: `run-${id}`, queueId: `queue-${id}`, conversationId };
}

test('completion reviews deduplicate exact tasks and serialize each origin conversation', async () => {
  const started = [];
  const releases = [];
  const queue = createPiTaskReviewQueue({ review: async (current, event) => {
    started.push([current.id, event.status]);
    await new Promise((resolve) => releases.push(resolve));
  } });
  assert.equal(queue.enqueue(task('one'), { status: 'completed' }), 'queued');
  assert.equal(queue.enqueue(task('one'), { status: 'completed' }), 'duplicate');
  assert.equal(queue.enqueue(task('two'), { status: 'failed' }), 'queued');
  assert.equal(queue.enqueue(task('other', 'other-origin'), { status: 'cancelled' }), 'queued');
  await yieldTurn();
  assert.deepEqual(started, [['one', 'completed']]);
  let originSettled = false;
  const originWait = queue.waitFor('origin').then(() => { originSettled = true; });
  await yieldTurn();
  assert.equal(originSettled, false);
  releases.shift()();
  await yieldTurn();
  assert.deepEqual(started, [['one', 'completed'], ['two', 'failed']]);
  assert.equal(originSettled, false);
  releases.shift()();
  await originWait;
  assert.equal(originSettled, true);
  assert.deepEqual(started.slice(0, 2), [['one', 'completed'], ['two', 'failed']]);
  if (releases.length) releases.shift()();
  await queue.waitFor('other-origin');
});

test('completion-review backpressure rejects excess queued work and continues after reviewer errors', async () => {
  let release;
  const errors = [];
  const seen = [];
  const queue = createPiTaskReviewQueue({
    maxQueued: 1,
    onError: (error) => errors.push(error.message),
    review: async (current) => {
      seen.push(current.id);
      if (current.id === 'one') await new Promise((resolve) => { release = resolve; });
      if (current.id === 'two') throw new Error('review failed');
    },
  });
  assert.equal(queue.enqueue(task('one'), { status: 'completed' }), 'queued');
  await yieldTurn();
  assert.equal(queue.enqueue(task('two'), { status: 'failed' }), 'queued');
  assert.equal(queue.enqueue(task('three'), { status: 'completed' }), 'full');
  release();
  await queue.waitFor('origin');
  assert.deepEqual(seen, ['one', 'two']);
  assert.deepEqual(errors, ['review failed']);
  assert.equal(queue.pendingCount, 0);
});
