import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { FridaySdkSession } from '../src/friday/friday-sdk-session.js';

async function setup(t, createSession) {
  const root = await mkdtemp(join(tmpdir(), 'friday-chat-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FridaySdkSession({
    cwd: root,
    agentDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    createModelRuntime: async () => ({}),
    createSession,
  });
  await adapter.start();
  t.after(() => adapter.stop());
  return adapter;
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await yieldTurn();
  }
  assert.fail('condition did not become true');
}

function sessionWithPrompt(prompt) {
  const session = {
    messages: [],
    prompt,
    modelRuntime: { getAvailableSnapshot: () => [] },
    dispose() {},
  };
  return session;
}

test('queued Friday messages execute in order and cancelling one queued item leaves active and unrelated work intact', async (t) => {
  const finish = new Map();
  const started = [];
  const session = sessionWithPrompt((message) => {
    started.push(message);
    session.messages.push({ role: 'user', content: message });
    return new Promise((resolve) => finish.set(message, () => {
      session.messages.push({ role: 'assistant', content: `reply:${message}` });
      resolve();
    }));
  });
  const adapter = await setup(t, async () => ({ session }));
  const first = adapter.enqueueChat('first');
  const cancelled = adapter.enqueueChat('cancel me');
  const third = adapter.enqueueChat('third');
  await until(() => started.length === 1);
  assert.deepEqual(started, ['first']);
  assert.equal(adapter.cancelQueuedChat(first.id), false, 'active work cannot be cancelled as a queued item');
  assert.equal(adapter.cancelQueuedChat(cancelled.id), true);
  assert.equal(adapter.cancelQueuedChat(cancelled.id), false, 'the same queued message cannot be cancelled twice');
  finish.get('first')();
  await until(() => started.length === 2);
  assert.deepEqual(started, ['first', 'third']);
  finish.get('third')();
  await until(() => adapter.getChatQueue().some((job) => job.id === third.id && job.status === 'completed'));
  assert.equal(adapter.getChatQueue().find((job) => job.id === cancelled.id).status, 'cancelled');
  assert.equal(adapter.getChatQueue().find((job) => job.id === first.id).status, 'completed');
  assert.equal(adapter.getChatQueue().find((job) => job.id === third.id).status, 'completed');
});

test('a failed Friday message is visible and does not prevent later queued messages from draining', async (t) => {
  const finish = new Map();
  const started = [];
  const session = sessionWithPrompt((message) => {
    started.push(message);
    session.messages.push({ role: 'user', content: message });
    return new Promise((resolve, reject) => finish.set(message, () => {
      if (message === 'bad') reject(new Error('provider failed'));
      else { session.messages.push({ role: 'assistant', content: 'reply' }); resolve(); }
    }));
  });
  const adapter = await setup(t, async () => ({ session }));
  const failed = adapter.enqueueChat('bad');
  const next = adapter.enqueueChat('next');
  await until(() => started.length === 1);
  finish.get('bad')();
  await until(() => started.length === 2);
  finish.get('next')();
  await until(() => adapter.getChatQueue().some((job) => job.id === next.id && job.status === 'completed'));
  assert.deepEqual(started, ['bad', 'next']);
  assert.equal(adapter.getChatQueue().find((job) => job.id === failed.id).status, 'failed');
  assert.match(adapter.getChatQueue().find((job) => job.id === failed.id).error, /provider failed/);
});

test('an error before a queued message starts remains visible and the FIFO continues', async (t) => {
  const session = sessionWithPrompt(async (message) => {
    session.messages.push({ role: 'user', content: message }, { role: 'assistant', content: 'reply' });
  });
  const adapter = await setup(t, async () => ({ session }));
  const failed = adapter.enqueueChat('pre-run failure', { beforeRun: async () => { throw 'review wait failed'; } });
  const next = adapter.enqueueChat('continues');
  await until(() => adapter.getChatQueue().some((job) => job.id === next.id && job.status === 'completed'));
  assert.equal(adapter.getChatQueue().find((job) => job.id === failed.id).status, 'failed');
  assert.match(adapter.getChatQueue().find((job) => job.id === failed.id).error, /review wait failed/);
});

test('host task review waits for idle turns and enqueues a follow-up while Friday is busy', async (t) => {
  let idle = true;
  let finishBusy;
  const sent = [];
  const session = sessionWithPrompt(async () => {});
  Object.defineProperty(session, 'isStreaming', { get: () => !idle });
  session.waitForIdle = () => idle ? Promise.resolve() : new Promise((resolve) => { finishBusy = resolve; });
  session.sendCustomMessage = async (message, options) => { sent.push({ message, options }); };
  const adapter = await setup(t, async () => ({ session }));
  const event = { taskId: 'task-a', content: 'trusted route; untrusted output', displayText: 'Reviewing task.' };
  const idleResult = await adapter.sendHostTaskEvent(event);
  assert.equal(idleResult.queued, false);
  assert.equal(sent[0].options.triggerTurn, true);

  idle = false;
  let finished = false;
  const busyReview = adapter.sendHostTaskEvent(event).then(() => { finished = true; });
  await until(() => sent.length === 2);
  assert.equal(sent[1].options.deliverAs, 'followUp');
  assert.equal(sent[1].options.triggerTurn, true);
  assert.equal(finished, false, 'the busy review waits for the queued review turn to settle');
  idle = true;
  finishBusy();
  await busyReview;
  assert.equal(finished, true);
});
