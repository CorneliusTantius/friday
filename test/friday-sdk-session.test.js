import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FridaySdkSession, fridayHistory } from '../src/friday-sdk-session.js';
import { fridaySystemPrompt } from '../src/friday-system-prompt.js';

test('Friday identity is explicit and multipurpose, not coding-only', () => {
  assert.match(fridaySystemPrompt, /Your identity is Friday: the user's multipurpose personal AI assistant/);
  assert.match(fridaySystemPrompt, /polished assistant manner of J\.A\.R\.V\.I\.S\./);
  assert.match(fridaySystemPrompt, /Whenever asked who or what you are, explicitly say you are Friday/);
  assert.match(fridaySystemPrompt, /I'm Friday, your personal AI assistant/);
  assert.match(fridaySystemPrompt, /Never identify yourself as merely an AI coding assistant/);
  assert.match(fridaySystemPrompt, /pi_list_conversations to find the intended saved Pi Agent conversation and its runId/);
  assert.match(fridaySystemPrompt, /one pi_wait_for_prompt call/);
  assert.match(fridaySystemPrompt, /Do not repeatedly call pi_run_status/);
  assert.match(fridaySystemPrompt, /Only call pi_stop_run when the user explicitly asks/);
});

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

test('SDK session aborts an active chat turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-sdk-abort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let finishPrompt;
  const session = {
    messages: [],
    prompt: () => new Promise((resolve) => { finishPrompt = () => { session.messages.push({ role: 'assistant', content: 'partial' }); resolve(); }; }),
    abort: async () => finishPrompt?.(),
    modelRuntime: { getAvailableSnapshot: () => [] },
    dispose() {},
  };
  const adapter = new FridaySdkSession({
    cwd: root,
    agentDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    createModelRuntime: async () => ({}),
    createSession: async () => ({ session }),
  });
  const turn = adapter.chat('long-running');
  for (let attempt = 0; attempt < 20 && !adapter.canAbort; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(adapter.canAbort, true);
  await assert.rejects(adapter.chat('concurrent'), /Cannot start chat while chat is in progress/);
  assert.equal(await adapter.abort(), true);
  await turn;
  assert.equal(adapter.isBusy, false);
  assert.equal(await adapter.abort(), false);
});

test('SDK session lists, creates, opens, renames, and deletes conversations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-sdk-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new FridaySdkSession({
    cwd: root,
    agentDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    createModelRuntime: async () => ({}),
    createSession: async ({ sessionManager }) => ({ session: {
      sessionManager,
      sessionFile: sessionManager.getSessionFile(),
      messages: [],
      modelRuntime: { getAvailableSnapshot: () => [] },
      dispose() {},
    } }),
  });

  const first = await adapter.newSession();
  adapter.sessionManager.appendMessage({ role: 'user', content: 'first conversation', timestamp: new Date().toISOString() });
  adapter.sessionManager.appendMessage({ role: 'assistant', content: 'saved reply', timestamp: new Date().toISOString() });
  const second = await adapter.newSession();
  adapter.sessionManager.appendMessage({ role: 'assistant', content: 'second conversation', timestamp: new Date().toISOString() });
  assert.notEqual(second, first);
  assert.deepEqual(new Set((await adapter.listSessions()).sessions.map(({ id }) => id)), new Set([second, first]));
  await adapter.openSession(first);
  assert.equal(adapter.sessionManager.getSessionId(), first);
  await adapter.renameSession(first, 'Planning');
  assert.equal((await adapter.listSessions()).sessions.find(({ id }) => id === first).name, 'Planning');
  await adapter.deleteSession(second);
  await assert.rejects(adapter.openSession(second), { status: 404 });
  const result = await adapter.deleteSession(first);
  assert.notEqual(result.currentSession, first);
  assert.equal((await adapter.listSessions()).currentSession, result.currentSession);
  await adapter.stop();
});

test('SDK session loads and persists model and thinking defaults without replacing settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-sdk-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  await mkdir(config, { recursive: true });
  const settingsPath = join(config, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ theme: 'dark', defaultProvider: 'mock', defaultModel: 'saved', defaultThinkingLevel: 'low' }));
  let options;
  const session = {
    messages: [], modelRuntime: { getAvailableSnapshot: () => [{ provider: 'mock', id: 'saved' }, { provider: 'mock', id: 'chosen' }] },
    setModel: async (model) => { session.model = model; },
    setThinkingLevel: async (level) => { session.thinkingLevel = level; }, dispose() {},
  };
  const adapter = new FridaySdkSession({ cwd: root, agentDir: config, dataDir: join(root, 'data'), createModelRuntime: async () => session.modelRuntime, createSession: async (value) => { options = value; return { session }; } });
  await adapter.start();
  assert.deepEqual(options.model, { provider: 'mock', id: 'saved' });
  assert.equal(options.thinkingLevel, 'low');
  await adapter.setModel('mock', 'chosen');
  await adapter.setThinkingLevel('high');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { theme: 'dark', defaultProvider: 'mock', defaultModel: 'chosen', defaultThinkingLevel: 'high' });
  await adapter.stop();
});

test('Friday SDK adds curated memory context and conversation-scoped Pi tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-sdk-memory-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let options;
  let memoryRead = false;
  let queued;
  const adapter = new FridaySdkSession({
    cwd: root, agentDir: join(root, 'config'), dataDir: join(root, 'data'),
    createModelRuntime: async () => ({ getAvailableSnapshot: () => [] }),
    memory: { readMemory: async () => { memoryRead = true; return '# User preferences\\nConcise answers'; } },
    piControl: {
      listConversations: async () => [],
      sendPrompt: async (input) => { queued = input; return { runId: '123e4567-e89b-12d3-a456-426614174000', queueId: '123e4567-e89b-12d3-a456-426614174001', position: 1 }; },
      waitForPrompt: async ({ runId, queueId }) => ({ runId, queueId, status: 'completed' }),
      getRunStatus: async () => ({ running: true }),
      readConversation: async ({ runId }) => ({ runId, messages: [] }),
      stopRun: async () => ({ stopped: true }),
    },
    createSession: async (value) => {
      options = value;
      assert.match(value.resourceLoader.getSystemPrompt(), /Your identity is Friday: the user's multipurpose personal AI assistant/);
      assert.match(value.resourceLoader.getSystemPrompt(), /one pi_wait_for_prompt call/);
      return { session: { sessionFile: value.sessionManager.getSessionFile(), messages: [], modelRuntime: value.modelRuntime, dispose() {} } };
    },
  });
  await adapter.start();
  assert.equal(memoryRead, true);
  assert.match(options.resourceLoader.getSystemPrompt(), /Your identity is Friday: the user's multipurpose personal AI assistant/);
  assert.match(options.resourceLoader.getSystemPrompt(), /one pi_wait_for_prompt call/);
  assert.deepEqual(options.tools, ['bash', 'edit', 'read', 'write', 'pi_list_conversations', 'pi_send_prompt', 'pi_wait_for_prompt', 'pi_run_status', 'pi_read_conversation', 'pi_stop_run']);
  assert.deepEqual(options.customTools.map((tool) => tool.name), ['pi_list_conversations', 'pi_send_prompt', 'pi_wait_for_prompt', 'pi_run_status', 'pi_read_conversation', 'pi_stop_run']);
  const sendTool = options.customTools.find((tool) => tool.name === 'pi_send_prompt');
  const result = await sendTool.execute('tool-call', { prompt: 'inspect this' }, undefined, undefined, undefined);
  assert.match(result.content[0].text, /queued.*run.*123e4567/i);
  assert.equal(queued.conversationId, adapter.currentSessionId);
  assert.equal(queued.prompt, 'inspect this');
  await adapter.stop();
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
    getContextUsage: () => ({ tokens: 40_000, contextWindow: 200_000, percent: 20 }),
    setModel: async (model) => { session.model = model; },
    setThinkingLevel: (level) => { session.thinkingLevel = level; session.level = level; },
    dispose: () => { disposed = true; },
  };
  const adapter = new FridaySdkSession({ cwd: '/tmp/friday', agentDir: '/tmp/friday-sdk-config', sessionManager: {}, model: 'initial-model', thinkingLevel: 'low', createModelRuntime: async (paths) => paths, createSession: async (value) => { options = value; return { session }; } });
  adapter.onEvent((event) => events.push(event));
  assert.equal(await adapter.chat('test'), 'test');
  assert.deepEqual(await adapter.getContextUsage(), { tokens: 40_000, contextWindow: 200_000, percent: 20 });
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
