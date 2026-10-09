import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPiSessionRenameAuthorized, hasExplicitPiSessionRenameAuthorization } from '../src/pi/pi-session-rename-policy.js';

const run = { id: '123e4567-e89b-12d3-a456-426614174000', sessionId: 'pi-session-1', name: 'Build task' };

test('rename authorization requires a direct request naming the exact session and new name', () => {
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'Please rename Pi session “Build task” to friday-ui.', run, name: 'friday-ui',
  }), true);
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: `Rename run ${run.id} to Friday UI`, run, name: 'Friday UI',
    otherRuns: [run, { id: 'run-2', sessionId: 'session-2', name: 'Build task' }],
  }), true, 'an explicit run ID disambiguates duplicate session names');
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'Could you rename the Build task session to friday-ui?', run, name: 'friday-ui',
  }), true);
});

test('rename authorization allows a unique recent host-created target without repeating its old name', () => {
  const hostSessionEvents = [{ type: 'created', runId: run.id, timestamp: 10_000 }];
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'rename that session [open] Friday Project 2', run, name: 'Friday Project 2', hostSessionEvents, now: 11_000,
  }), true);
});

test('rename authorization rejects ambiguous, stale, and untrusted contextual references', () => {
  const event = { type: 'created', runId: run.id, timestamp: 10_000 };
  const request = { userMessage: 'rename that session Friday Project 2', run, name: 'Friday Project 2', now: 11_000 };
  assert.equal(hasExplicitPiSessionRenameAuthorization({ ...request, hostSessionEvents: [event, { ...event, runId: 'other-run' }] }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({ ...request, now: 400_000, hostSessionEvents: [{ ...event, timestamp: 0 }] }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({ ...request, hostSessionEvents: [{ ...event, type: 'assistant-said-created' }] }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({ ...request, hostSessionEvents: [{ ...event, runId: 'other-run' }] }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({ ...request, hostSessionEvents: [event], userMessage: 'Rename that session to Friday Project 2 if you think so.' }), false);
});

test('rename authorization rejects ambiguous, conditional, unrelated, and assistant-only requests', () => {
  assert.equal(hasExplicitPiSessionRenameAuthorization({ userMessage: 'Rename the session to friday-ui.', run, name: 'friday-ui' }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({ userMessage: 'Rename Build to friday-ui.', run, name: 'friday-ui' }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'Rename Build task to friday-ui if it seems useful.', run, name: 'friday-ui',
  }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'Do not rename Build task to friday-ui.', run, name: 'friday-ui',
  }), false);
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'Rename Pi session “Build task” to friday-ui.', run, name: 'other-name',
  }), false, 'the requested name must match the current user turn');
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'Rename friday-ui to Build task.', run, name: 'friday-ui',
  }), false, 'the requested new name must be the rename destination');
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: `Rename run ${run.id}extra to friday-ui`, run, name: 'friday-ui',
  }), false, 'a partial run ID does not identify the exact session');
  assert.equal(hasExplicitPiSessionRenameAuthorization({
    userMessage: 'Help with the Friday UI.',
    previousAssistantMessage: 'Please rename Pi session “Build task” to friday-ui.',
    run, name: 'friday-ui',
  }), false, 'assistant-only wording cannot authorize a rename');
  assert.throws(() => assertPiSessionRenameAuthorized({ userMessage: 'Rename the session.', run, name: 'friday-ui' }), { status: 403 });
});
