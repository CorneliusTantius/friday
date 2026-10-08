import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPiRunStopAuthorized, hasExplicitPiRunStopAuthorization } from '../src/pi/pi-run-stop-policy.js';

const run = { id: '123e4567-e89b-12d3-a456-426614174000', sessionId: 'session-1', name: 'Billing API' };

test('Pi run stop requires an explicit request naming a unique target', () => {
  assert.equal(hasExplicitPiRunStopAuthorization({ userMessage: 'Stop the Billing API run.', run, otherRuns: [run] }), true);
  assert.equal(hasExplicitPiRunStopAuthorization({ userMessage: `Please cancel run ${run.id}.`, run, otherRuns: [run] }), true);
  assert.equal(hasExplicitPiRunStopAuthorization({ userMessage: 'Stop the run.', run, otherRuns: [run] }), false);
  assert.equal(hasExplicitPiRunStopAuthorization({ userMessage: 'Do not stop the Billing API run.', run, otherRuns: [run] }), false);
  assert.equal(hasExplicitPiRunStopAuthorization({ userMessage: 'Stop the Billing API run.', run, otherRuns: [run, { name: 'Billing API' }] }), false);
  assert.throws(() => assertPiRunStopAuthorized({ userMessage: 'Stop the run.', run, otherRuns: [run] }), { status: 403 });
});
