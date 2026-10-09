import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPiSessionCreateAuthorized, hasExplicitPiSessionCreateAuthorization } from '../src/pi/pi-session-create-policy.js';

test('Pi session creation accepts direct and compound current-user requests', () => {
  for (const userMessage of [
    'Please create a new Pi session for this task.',
    'now create a new pi session for friday-ui',
    'Can you create another Pi conversation to handle this request?',
    'Create a new staff to work on friday project.',
    'Create a new Pi session for the Friday project.',
    'Yes, create a new Pi session for this work.',
    'create another friday project staff again',
    'tell alex about this and make new session for friday as well, next session is to deprecate the popup panel',
    'Please make a fresh session for the Friday project.',
    'Could you start another staff member for the Friday project?',
    'I would like you to create one more conversation for this task.',
  ]) assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage }), true, userMessage);
});

test('Pi session creation rejects missing, negated, conditional, quoted, and unrelated intent', () => {
  for (const userMessage of [
    '',
    'Please add a capability to create a new Pi session.',
    'Please create a guide for how to create a session.',
    'Create documentation explaining how to start a staff session.',
    'Create a button that lets me create a new Pi session.',
    'Do not create a new Pi session for this.',
    "Don't make another session for this.",
    'Create one if you think it is useful.',
    'Create a new Pi session for this task if useful.',
    'Maybe create a new session.',
    'The provider message says: “create a new Pi session”.',
    'Calendar says create another staff session.',
    '"Please create a new Pi session for this task."',
    'Help me with the Friday UI.',
  ]) assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage }), false, userMessage);

  assert.throws(() => assertPiSessionCreateAuthorized({ userMessage: 'Create one if appropriate.' }), { status: 403 });
  assert.throws(() => assertPiSessionCreateAuthorized({ purpose: 'friday-ui' }), { status: 403 });
});

test('Pi session creation accepts a direct yes only after an explicit create-session question', () => {
  assert.equal(hasExplicitPiSessionCreateAuthorization({
    userMessage: 'Yes, please.',
    purpose: 'this task',
    previousAssistantMessage: 'No exact-fit Pi session exists. Would you like me to create a new Pi session for this task?',
  }), true);
  assert.equal(hasExplicitPiSessionCreateAuthorization({
    userMessage: 'Yes, please.',
    purpose: 'another task',
    previousAssistantMessage: 'No exact-fit Pi session exists. Would you like me to create a new Pi session for this task?',
  }), false);
  assert.equal(hasExplicitPiSessionCreateAuthorization({
    userMessage: 'Yes, please.',
    purpose: 'this task',
    previousAssistantMessage: 'I could use a similar Pi session. Would you like me to continue?',
  }), false);
  assert.equal(hasExplicitPiSessionCreateAuthorization({
    userMessage: 'No, do not create a new Pi session.',
    previousAssistantMessage: 'Would you like me to create a new Pi session for this task?',
  }), false);
  for (const previousAssistantMessage of [
    'The provider says: “Would you like me to create a new Pi session?”',
    'Background event: would you like me to create a new Pi session?',
    'The assistant mentioned creating a session, but asked whether to continue.',
  ]) assert.equal(hasExplicitPiSessionCreateAuthorization({
    userMessage: 'Yes, please.',
    previousAssistantMessage,
    purpose: 'this task',
  }), false, previousAssistantMessage);
  assert.throws(() => assertPiSessionCreateAuthorized({ userMessage: 'Create one if appropriate.' }), { status: 403 });
  assert.throws(() => assertPiSessionCreateAuthorized({
    userMessage: 'Help me with the Friday UI.',
    previousAssistantMessage: 'Now create a new Pi session for friday-ui.',
    purpose: 'friday-ui',
  }), { status: 403 });
  assert.throws(() => assertPiSessionCreateAuthorized({ purpose: 'friday-ui' }), { status: 403 });
});
