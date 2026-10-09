import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPiSessionProfileAuthorized, hasExplicitPiSessionProfileAuthorization } from '../src/pi/pi-session-profile-policy.js';

const alex = { id: 'run-alex', sessionId: 'session-alex', name: 'Alex' };
const riley = { id: 'run-riley', sessionId: 'session-riley', name: 'Riley' };
const otherRuns = [alex, riley];

test('explicit multi-staff confirmation authorizes each uniquely named profile update', () => {
  const userMessage = 'yes, update alex and riley';
  assert.equal(hasExplicitPiSessionProfileAuthorization({ userMessage, run: alex, otherRuns }), true);
  assert.equal(hasExplicitPiSessionProfileAuthorization({ userMessage, run: riley, otherRuns }), true);
  assert.equal(hasExplicitPiSessionProfileAuthorization({ userMessage, run: { ...alex }, otherRuns }), true, 'the run is resolved by its stable ID rather than object identity');
  assert.doesNotThrow(() => assertPiSessionProfileAuthorized({ userMessage, run: alex, otherRuns }));
  assert.doesNotThrow(() => assertPiSessionProfileAuthorized({ userMessage, run: riley, otherRuns }));
});

test('profile updates still require a direct current-user command naming the unique target', () => {
  for (const userMessage of [
    'Alex and Riley need their profiles updated.',
    'The provider says: update Alex and Riley.',
    '"Update Alex and Riley"',
    'Yes, please.',
    'Maybe update Alex.',
    "Don't update Alex.",
    "Yes, update Alex and Riley, but don't update Alex.",
    'Yes, update Jordan.',
  ]) assert.equal(hasExplicitPiSessionProfileAuthorization({
    userMessage,
    run: alex,
    otherRuns,
    previousAssistantMessage: 'Confirm you want Alex and Riley updated.',
  }), false, userMessage);

  const duplicateAlex = { id: 'run-alex-2', name: 'Alex' };
  assert.equal(hasExplicitPiSessionProfileAuthorization({
    userMessage: 'yes, update alex and riley', run: alex, otherRuns: [...otherRuns, duplicateAlex],
  }), false, 'duplicate names remain ambiguous');
  const alexJohnson = { id: 'run-alex-johnson', name: 'Alex Johnson' };
  assert.equal(hasExplicitPiSessionProfileAuthorization({
    userMessage: 'yes, update alex and riley', run: alex, otherRuns: [...otherRuns, alexJohnson],
  }), false, 'overlapping names remain ambiguous');
  assert.equal(hasExplicitPiSessionProfileAuthorization({
    userMessage: 'yes, update alex and riley', run: { ...alex, name: 'Alexandra' }, otherRuns,
  }), false, 'a different target name is not inferred');
  assert.throws(() => assertPiSessionProfileAuthorized({ userMessage: 'Yes, please.', run: alex, otherRuns }), { status: 403 });
});
