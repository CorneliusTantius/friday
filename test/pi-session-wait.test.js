import test from 'node:test';
import assert from 'node:assert/strict';
import { PiSession } from '../src/pi-session.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const session = () => new PiSession({ cwd: '/tmp' });

test('waitForPrompt returns terminal results even when completion was immediate', async () => {
  const pi = session();
  pi.chat = async (message) => message;
  const queued = pi.enqueuePrompt('fast');
  assert.deepEqual(await pi.waitForPrompt(queued.id), { queueId: queued.id, status: 'completed', result: 'fast' });
  assert.deepEqual(await pi.waitForPrompt(queued.id), { queueId: queued.id, status: 'completed', result: 'fast' });
});

test('waitForPrompt correlates FIFO results to the exact queue item', async () => {
  const pi = session();
  const gates = [];
  const started = [];
  pi.chat = (message) => {
    started.push(message);
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  };
  const first = pi.enqueuePrompt('first');
  const second = pi.enqueuePrompt('second');
  const firstWait = pi.waitForPrompt(first.id);
  const secondWait = pi.waitForPrompt(second.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  gates[0].resolve('reply one');
  assert.deepEqual(await firstWait, { queueId: first.id, status: 'completed', result: 'reply one' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'second']);
  gates[1].resolve('reply two');
  assert.deepEqual(await secondWait, { queueId: second.id, status: 'completed', result: 'reply two' });
});

test('waitForPrompt reports failed jobs and cleared queued jobs as terminal outcomes', async () => {
  const pi = session();
  const gate = deferred();
  pi.chat = async (message) => {
    if (message === 'fail') throw new Error('Pi failed');
    return gate.promise;
  };
  const failed = pi.enqueuePrompt('fail');
  assert.deepEqual(await pi.waitForPrompt(failed.id), { queueId: failed.id, status: 'failed', error: 'Pi failed' });

  const blocker = pi.enqueuePrompt('blocker');
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = pi.enqueuePrompt('cancelled');
  const wait = pi.waitForPrompt(cancelled.id);
  assert.equal(pi.clearPromptQueue(), 1);
  assert.deepEqual(await wait, { queueId: cancelled.id, status: 'cancelled', error: 'Prompt queue cleared', cancelled: true });
  gate.resolve('done');
  assert.deepEqual(await pi.waitForPrompt(blocker.id), { queueId: blocker.id, status: 'completed', result: 'done' });
});

test('timeout and caller cancellation stop only the waiter and clean up waiters', async () => {
  const pi = session();
  const gate = deferred();
  let aborted = false;
  pi.abort = async () => { aborted = true; return true; };
  pi.chat = () => gate.promise;
  const queued = pi.enqueuePrompt('slow');
  const timedOut = await pi.waitForPrompt(queued.id, { timeoutMs: 5 });
  assert.deepEqual(timedOut, { queueId: queued.id, status: 'timed_out' });
  assert.equal(aborted, false);

  const controller = new AbortController();
  const cancelledWait = pi.waitForPrompt(queued.id, { signal: controller.signal });
  assert.equal(pi.promptJobs.get(queued.id).waiters.size, 1);
  controller.abort();
  assert.deepEqual(await cancelledWait, { queueId: queued.id, status: 'cancelled' });
  assert.equal(pi.promptJobs.get(queued.id).waiters.size, 0);
  assert.equal(aborted, false);

  gate.resolve('eventually done');
  assert.deepEqual(await pi.waitForPrompt(queued.id), { queueId: queued.id, status: 'completed', result: 'eventually done' });
});

test('waitForPrompt handles already-aborted signals and unknown queue IDs', async () => {
  const pi = session();
  const controller = new AbortController();
  const gate = deferred();
  pi.chat = () => gate.promise;
  controller.abort();
  assert.deepEqual(await pi.waitForPrompt('missing'), { queueId: 'missing', status: 'not_found' });
  const active = pi.enqueuePrompt('active');
  await new Promise((resolve) => setImmediate(resolve));
  const queued = pi.enqueuePrompt('pending');
  assert.deepEqual(await pi.waitForPrompt(queued.id, { signal: controller.signal }), { queueId: queued.id, status: 'cancelled' });
  assert.equal(pi.clearPromptQueue(), 1);
  gate.resolve('finished');
  await pi.waitForPrompt(active.id);
});
