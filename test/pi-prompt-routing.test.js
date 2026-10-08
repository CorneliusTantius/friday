import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPiRunAcceptsPrompt, resolveSelectedPiRun } from '../src/pi/pi-prompt-routing.js';

const closed = { id: '123e4567-e89b-12d3-a456-426614174000', name: '[closed] friday', closed: true };
const similar = { id: '123e4567-e89b-12d3-a456-426614174001', name: 'friday review', closed: false };

function registry(runs, linked = null) {
  return {
    getRun: async (id) => runs.find((run) => run.id === id) || null,
    getLinkedRun: async () => linked,
  };
}

test('closed runs remain resolvable for reading and status but reject prompt delivery', async () => {
  const run = await resolveSelectedPiRun({ runId: closed.id, runRegistry: registry([closed]) });
  assert.equal(run, closed, 'history and status can resolve the closed run');
  assert.throws(() => assertPiRunAcceptsPrompt(run), { status: 409, message: /closed and cannot receive prompts/ });
});

test('conversation-linked prompt selection refuses a closed Pi run', async () => {
  const run = await resolveSelectedPiRun({ conversationId: 'friday-chat', runRegistry: registry([closed], closed) });
  assert.throws(() => assertPiRunAcceptsPrompt(run), { status: 409, message: /closed and cannot receive prompts/ });
});

test('similarly named open Pi sessions remain promptable', async () => {
  const run = await resolveSelectedPiRun({ runId: similar.id, runRegistry: registry([similar]) });
  assert.equal(assertPiRunAcceptsPrompt(run).id, similar.id);
});
