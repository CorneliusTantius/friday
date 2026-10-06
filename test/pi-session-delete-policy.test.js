import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPiSessionDeletable, deletePiSessionWithPolicy, hasExplicitPiSessionDeleteAuthorization } from '../src/pi-session-delete-policy.js';

const run = { id: '123e4567-e89b-12d3-a456-426614174000', sessionId: 'pi-session-1', name: 'Build task' };

test('Pi session deletion requires a direct request naming the target or explicit post-completion approval', () => {
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: 'Please delete Pi session “Build task”.', run }), true);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: `Delete run ${run.id}`, run }), true);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: 'Delete the session', run }), false);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: 'Delete Pi session Build task', run, otherRuns: [run, { id: 'other', name: 'Build task' }] }), false);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: `Delete run ${run.id}`, run, otherRuns: [run, { id: 'other', name: 'Build task' }] }), true);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: 'Do not delete Pi session Build task', run }), false);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: 'Can I delete Pi session Build task?', run }), false);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({
    userMessage: 'Please delete Pi session “Build task”.', run,
    otherRuns: [run, { id: 'run-2', name: 'Build task' }],
  }), false, 'duplicate names require an exact ID');
  assert.equal(hasExplicitPiSessionDeleteAuthorization({
    userMessage: 'Yes, please.',
    previousAssistantMessage: 'The task is complete. Would you like me to delete Pi session “Build task”? Reply yes to confirm.',
    run,
  }), true);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({
    userMessage: 'Yes, delete it.',
    previousAssistantMessage: 'The task is complete. Would you like me to delete Pi session “Build task”?',
    run,
  }), true);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({
    userMessage: 'Yes, please.',
    previousAssistantMessage: 'Would you like me to delete Pi session “Build task”?',
    run,
  }), false);
  assert.equal(hasExplicitPiSessionDeleteAuthorization({ userMessage: 'Yes, please.', previousAssistantMessage: '', run }), false);
});

test('deletion policy gates the destructive callback on authorization and safe state', async () => {
  let removals = 0;
  const remove = async () => { removals += 1; return 'removed'; };
  await assert.rejects(deletePiSessionWithPolicy({ runId: run.id, run, userMessage: 'Delete the session', remove }), { status: 403 });
  assert.equal(removals, 0);
  await assert.rejects(deletePiSessionWithPolicy({
    runId: run.id, run, userMessage: `Delete run ${run.id}`, linkedRunId: run.id, remove,
  }), { status: 409 });
  assert.equal(removals, 0);
  assert.equal(await deletePiSessionWithPolicy({ runId: run.id, run, userMessage: `Delete run ${run.id}`, remove }), 'removed');
  assert.equal(removals, 1);
});

test('Pi session deletion refuses linked, opening, active, queued, and currently open sessions', () => {
  assert.throws(() => assertPiSessionDeletable({ runId: run.id, linkedRunId: run.id }), { status: 409 });
  assert.throws(() => assertPiSessionDeletable({ runId: run.id, opening: true }), { status: 409 });
  assert.throws(() => assertPiSessionDeletable({ runId: run.id, runtimes: [{ pi: { hasActiveWork: true } }] }), { status: 409 });
  assert.throws(() => assertPiSessionDeletable({ runId: run.id, runtimes: [{ pi: { promptQueue: ['queued'] } }] }), { status: 409 });
  assert.throws(() => assertPiSessionDeletable({ runId: run.id, runtimes: [{ pi: { hasActiveWork: false } }] }), { status: 409 });
  assert.doesNotThrow(() => assertPiSessionDeletable({ runId: run.id }));
});
