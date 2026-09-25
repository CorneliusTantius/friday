import test from 'node:test';
import assert from 'node:assert/strict';
import { FridaySdkSession, fridayHistory } from '../src/friday-sdk-session.js';

test('Friday history projects SDK messages and limits the tail', () => {
  const messages = [
    { role: 'system', content: 'hidden' },
    { role: 'user', content: [{ type: 'text', text: ' hello ' }] },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'tool', content: [{ type: 'text', text: 'result' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'README.md' } }] },
    { role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [{ type: 'text', text: 'file contents' }] },
    { role: 'assistant', content: [{ type: 'text', text: ' answer ' }] },
  ];
  assert.deepEqual(fridayHistory(messages), [
    { role: 'user', content: 'hello' },
    { role: 'tool', content: 'result', toolCallId: 'call-1', toolName: 'tool' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-2', name: 'read', arguments: { path: 'README.md' } }] },
    { role: 'tool', content: 'file contents', toolCallId: 'call-2', toolName: 'read' },
    { role: 'assistant', content: 'answer' },
  ]);
});

test('SDK session initializes once, disables tools, and disposes', async () => {
  let options;
  let disposed = false;
  const events = [];
  const session = {
    messages: [],
    subscribe: (listener) => { session.emit = listener; return () => {}; },
    prompt: async (text) => { session.messages.push({ role: 'assistant', content: [{ type: 'text', text } ] }); },
    modelRuntime: { getAvailableSnapshot: () => [{ provider: 'mock', id: 'next-model' }] },
    getAvailableThinkingLevels: () => ['off', 'low', 'high'],
    setModel: async (model) => { session.model = model; },
    setThinkingLevel: (level) => { session.thinkingLevel = level; session.level = level; },
    dispose: () => { disposed = true; },
  };
  const adapter = new FridaySdkSession({ cwd: '/tmp/friday', agentDir: '/tmp/friday-sdk-config', sessionManager: {}, model: 'initial-model', thinkingLevel: 'low', createModelRuntime: async (paths) => paths, createSession: async (value) => { options = value; return { session }; } });
  adapter.onEvent((event) => events.push(event));
  assert.equal(await adapter.chat('test'), 'test');
  assert.equal(options.cwd, '/tmp/friday');
  assert.deepEqual(options.tools, ['bash', 'edit', 'read', 'write']);
  assert.equal(options.noTools, undefined);
  assert.equal(options.modelRuntime.authPath, '/tmp/friday-sdk-config/auth.json');
  assert.equal(options.modelRuntime.modelsPath, '/tmp/friday-sdk-config/models.json');
  assert.ok(options.settingsManager, 'Friday uses its own SDK settings manager');
  assert.equal(options.agentDir, '/tmp/friday-sdk-config');
  assert.notEqual(options.agentDir, process.env.PI_CODING_AGENT_DIR);
  assert.equal(options.model, 'initial-model');
  assert.equal(options.thinkingLevel, 'low');
  assert.deepEqual(options.resourceLoader.getSkills().skills, []);
  assert.deepEqual(options.resourceLoader.getExtensions().extensions, []);
  const event = { type: 'agent_start' };
  session.emit(event);
  assert.deepEqual(events, [event]);
  assert.equal(adapter.isRunning, true);
  assert.equal(adapter.currentThinkingLevel, 'low');
  assert.deepEqual(await adapter.availableModels(), [{ provider: 'mock', id: 'next-model' }]);
  assert.deepEqual(await adapter.availableThinkingLevels(), ['off', 'low', 'high']);
  await adapter.setModel('mock', 'next-model');
  await adapter.setThinkingLevel('high');
  assert.deepEqual(session.model, { provider: 'mock', id: 'next-model' });
  assert.equal(session.level, 'high');
  await adapter.stop();
  assert.equal(disposed, true);
});
