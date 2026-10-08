import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiTaskReviewQueue } from '../src/friday/pi-task-review-queue.js';
import { createPiTaskReviewHandler } from '../src/friday/pi-task-review.js';

test('queued review receives task and event, starts, and never assumes an unreported success', async () => {
  const task = {
    id: 'task-1', runId: 'run-1', queueId: 'queue-1', conversationId: 'friday-1', label: 'Build feature',
    status: 'reviewing', review: { stage: 'queued', queuedAt: new Date().toISOString() },
  };
  let saved = { ...task, review: { ...task.review } };
  const registry = {
    async getTask(id) { assert.equal(id, task.id); return { ...saved, review: { ...saved.review } }; },
    async updateTask(id, patch) {
      assert.equal(id, task.id);
      saved = { ...saved, ...patch, review: { ...saved.review, ...patch.review } };
      return saved;
    },
  };
  const events = [];
  const audits = [];
  const pi = {
    currentSessionId: task.conversationId,
    async sendHostTaskEvent(event) { events.push(event); },
  };
  const review = createPiTaskReviewHandler({
    registry,
    getFridayPi: async () => pi,
    restrictedControl: {},
    audit: (name, fields) => audits.push({ name, ...fields }),
  });
  const queue = createPiTaskReviewQueue({ review });
  const completionEvent = { status: 'completed', result: 'Pi output awaiting verification' };

  assert.equal(queue.enqueue(task, completionEvent), 'queued');
  await queue.waitFor(task.conversationId);

  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, task.id);
  assert.match(events[0].content, /Pi output awaiting verification/);
  assert.ok(audits.some((entry) => entry.name === 'review_started' && entry.taskId === task.id && entry.runId === task.runId && entry.queueId === task.queueId));
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.review.stage, 'failed');
  assert.equal(saved.review.errorCode, 'report_missing');
  assert.ok(audits.some((entry) => entry.name === 'review_failed' && entry.errorCode === 'report_missing'));
});
