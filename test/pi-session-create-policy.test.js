import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPiSessionCreateAuthorized, hasExplicitPiSessionCreateAuthorization } from '../src/pi/pi-session-create-policy.js';

test('Pi session creation requires an explicit, affirmative request for work', () => {
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'Please create a new Pi session for this task.' }), true);
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'now create a new pi session for friday-ui', purpose: 'friday-ui' }), true);
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'Can you create another Pi conversation to handle this request?' }), true);
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'Yes, create a new Pi session for this work.' }), true);
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'Please add a capability to create a new Pi session.' }), false);
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'Do not create a new Pi session for this.' }), false);
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'Create one if you think it is useful.' }), false);
  assert.equal(hasExplicitPiSessionCreateAuthorization({ userMessage: 'Create a new Pi session for this task if useful.' }), false);
  assert.equal(hasExplicitPiSessionCreateAuthorization({
    userMessage: 'Help me with the Friday UI.',
    previousAssistantMessage: 'Now create a new Pi session for friday-ui.',
    purpose: 'friday-ui',
  }), false);
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
  assert.throws(() => assertPiSessionCreateAuthorized({ userMessage: 'Create one if appropriate.' }), { status: 403 });
  assert.throws(() => assertPiSessionCreateAuthorized({
    userMessage: 'Help me with the Friday UI.',
    previousAssistantMessage: 'Now create a new Pi session for friday-ui.',
    purpose: 'friday-ui',
  }), { status: 403 });
  assert.throws(() => assertPiSessionCreateAuthorized({ purpose: 'friday-ui' }), { status: 403 });
});
