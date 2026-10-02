import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayPiTools } from '../src/friday-pi-tools.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
const invoke = (tool, args, signal) => tool.execute('call', args, signal, undefined, undefined);

test('defines tools with schemas and queues prompts without waiting', async () => {
  const calls = [];
  const reads = [];
  let waitSignal;
  const tools = createFridayPiTools({
    listConversations: async () => [{ id: 'c1', name: 'Build task', runId: id, path: '/private/session.jsonl', preview: 'private message' }],
    sendPrompt: async (value) => { calls.push(value); return { runId: id, queueId: id, position: 2 }; },
    getRunStatus: async (runId) => ({ runId, state: 'running' }),
    readConversation: async (value) => { reads.push(value); return { runId: value.runId, messages: [{ role: 'assistant', content: 'Pi reply' }] }; },
    stopRun: async (runId) => ({ runId, stopped: true }),
    waitForPrompt: async (value) => { waitSignal = value.signal; return { runId: value.runId, queueId: value.queueId, status: 'completed', result: 'done' }; },
    getConversationId: () => 'c1',
  });
  assert.deepEqual(tools.map((tool) => tool.name), ['pi_list_conversations', 'pi_send_prompt', 'pi_wait_for_prompt', 'pi_run_status', 'pi_read_conversation', 'pi_stop_run']);
  assert.deepEqual(await invoke(tools[0], {}), { content: [{ type: 'text', text: JSON.stringify([{ id: 'c1', name: 'Build task', runId: id }]) }] });
  const prompt = tools[1];
  assert.match(prompt.description, /queue.*without.*wait|return immediately.*does not wait/i);
  assert.equal(prompt.parameters.properties.prompt.maxLength, 20000);
  assert.deepEqual(await invoke(prompt, { prompt: 'hello', runId: id }), {
    content: [{ type: 'text', text: `Prompt queued for run ${id} with queueId ${id} (queue position 2). Pi completion is not awaited.` }],
  });
  assert.deepEqual(calls, [{ prompt: 'hello', runId: id, conversationId: 'c1' }]);
  assert.equal(tools[2].parameters.properties.timeoutMs.maximum, 120000);
  const controller = new AbortController();
  assert.deepEqual(await invoke(tools[2], { runId: id, queueId: id }, controller.signal), {
    content: [{ type: 'text', text: JSON.stringify({ runId: id, queueId: id, status: 'completed', result: 'done' }) }],
  });
  assert.equal(waitSignal, controller.signal);
  assert.deepEqual(await invoke(tools[3], { runId: id }), { content: [{ type: 'text', text: JSON.stringify({ runId: id, state: 'running' }) }] });
  assert.match(tools[4].description, /most recent messages/);
  assert.equal(tools[4].parameters.properties.limit.maximum, 10);
  assert.deepEqual(await invoke(tools[4], { runId: id, limit: 5 }), {
    content: [{ type: 'text', text: JSON.stringify({ runId: id, messages: [{ role: 'assistant', content: 'Pi reply' }] }) }],
  });
  assert.deepEqual(reads, [{ runId: id, limit: 5 }]);
  assert.match(tools[5].description, /only use when the user explicitly asks/i);
  assert.deepEqual(await invoke(tools[5], { runId: id }), { content: [{ type: 'text', text: JSON.stringify({ runId: id, stopped: true }) }] });
});
