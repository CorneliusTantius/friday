import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayPiTools } from '../src/friday-pi-tools.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
const invoke = (tool, args) => tool.execute('call', args, undefined, undefined, undefined);

test('defines tools with schemas and queues prompts without waiting', async () => {
  const calls = [];
  const tools = createFridayPiTools({
    listConversations: async () => [{ id: 'c1' }],
    sendPrompt: async (value) => { calls.push(value); return { runId: id, position: 2 }; },
    getRunStatus: async (runId) => ({ runId, state: 'running' }),
    stopRun: async (runId) => ({ runId, stopped: true }),
    getConversationId: () => 'c1',
  });
  assert.deepEqual(tools.map((tool) => tool.name), ['pi_list_conversations', 'pi_send_prompt', 'pi_run_status', 'pi_stop_run']);
  assert.deepEqual(await invoke(tools[0], {}), { content: [{ type: 'text', text: '[{"id":"c1"}]' }] });
  const prompt = tools[1];
  assert.match(prompt.description, /queue.*without.*wait|return immediately.*does not wait/i);
  assert.equal(prompt.parameters.properties.prompt.maxLength, 20000);
  assert.deepEqual(await invoke(prompt, { prompt: 'hello', runId: id }), {
    content: [{ type: 'text', text: `Prompt queued for run ${id} (queue position 2). Pi completion is not awaited.` }],
  });
  assert.deepEqual(calls, [{ prompt: 'hello', runId: id, conversationId: 'c1' }]);
  assert.deepEqual(await invoke(tools[2], { runId: id }), { content: [{ type: 'text', text: JSON.stringify({ runId: id, state: 'running' }) }] });
  assert.match(tools[3].description, /only use when the user explicitly asks/i);
  assert.deepEqual(await invoke(tools[3], { runId: id }), { content: [{ type: 'text', text: JSON.stringify({ runId: id, stopped: true }) }] });
});
