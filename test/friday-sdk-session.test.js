import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FridaySdkSession, fridayHistory } from '../src/friday/friday-sdk-session.js';
import { fridaySystemPrompt } from '../src/friday/friday-system-prompt.js';

test('Friday prompt establishes orchestration, exact-fit delegation, and safe Pi lifecycle', () => {
  assert.match(fridaySystemPrompt, /personal assistant and work orchestrator/);
  assert.match(fridaySystemPrompt, /delegate substantive project work/);
  assert.match(fridaySystemPrompt, /select only a conversation whose session name, expertise, responsibilities, visibleRepositories \(app-provided repository context\), domain, and recent context fit/);
  assert.match(fridaySystemPrompt, /Session names are staff names, but never infer a runId from a name/);
  assert.doesNotMatch(fridaySystemPrompt, /displayName|repositories \(staff-fit metadata\)/);
  assert.match(fridaySystemPrompt, /If a user reference matches multiple sessions, ask which one before acting/);
  assert.match(fridaySystemPrompt, /Visible repositories describe app-provided context, not a filesystem sandbox/);
  assert.match(fridaySystemPrompt, /not a filesystem sandbox/);
  assert.match(fridaySystemPrompt, /ask before creating or selecting another session/);
  assert.match(fridaySystemPrompt, /Rename only through action rename/);
  assert.match(fridaySystemPrompt, /explicit current-user request naming that exact session and name/);
  assert.match(fridaySystemPrompt, /pi_send_prompt always requires the listed runId/);
  assert.match(fridaySystemPrompt, /objective, acceptance checks, constraints/);
  assert.match(fridaySystemPrompt, /persisted stages/);
  assert.match(fridaySystemPrompt, /pi_report_task as completed only when verified/);
  assert.match(fridaySystemPrompt, /Never create, rename, delete, stop, install, push, send another prompt/);
  assert.match(fridaySystemPrompt, /never resend/);
  assert.match(fridaySystemPrompt, /Stop a Pi run only through pi_stop_run when the current user explicitly asks to stop that exact run/);
  assert.match(fridaySystemPrompt, /Delete only through pi_manage_session action delete, on an explicit request naming that exact session/);
  assert.match(fridaySystemPrompt, /Skip technical details unless asked/);
  assert.match(fridaySystemPrompt, /lead with the delivered outcome, then use concise bullets and short sentences/);
  assert.match(fridaySystemPrompt, /Include technical details when requested or needed to explain a risk or blocker/);
  assert.match(fridaySystemPrompt, /Preserve accuracy, distinguish facts from uncertainty/);
  assert.match(fridaySystemPrompt, /Never delete the Pi conversation linked to this Friday conversation/);
});

test('Friday history projects SDK messages and limits the tail', () => {
  const messages = [
    { role: 'system', content: 'hidden' },
    { role: 'custom', customType: 'friday_pi_task_completion', content: 'raw private payload', details: { taskId: 'task-1', displayText: 'Friday is reviewing Pi task.' } },
    { role: 'user', content: [{ type: 'text', text: ' hello ' }] },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'tool', content: [{ type: 'text', text: 'result' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'README.md' } }] },
    { role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [{ type: 'text', text: 'file contents' }] },
    { role: 'assistant', content: [{ type: 'text', text: ' answer ' }] },
  ];
  assert.deepEqual(fridayHistory(messages), [
    { role: 'event', content: 'Friday is reviewing Pi task.' },
    { role: 'user', content: 'hello' },
    { role: 'tool', content: 'result', toolCallId: 'call-1', toolName: 'tool' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-2', name: 'read', arguments: { path: 'README.md' } }] },
    { role: 'tool', content: 'file contents', toolCallId: 'call-2', toolName: 'read' },
    { role: 'assistant', content: 'answer' },
  ]);

  const firstSnapshot = fridayHistory([
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
  ], 'session-a');
  const updatedSnapshot = fridayHistory([
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'partial reply' }] },
  ], 'session-a');
  assert.equal(firstSnapshot[1].id, updatedSnapshot[1].id, 'partial streaming updates retain a stable message ID');
  assert.notEqual(firstSnapshot[1].revision, updatedSnapshot[1].revision, 'message revisions detect changed partial output');
  assert.equal(firstSnapshot[1].prefixRevision, updatedSnapshot[1].prefixRevision, 'the preceding-history cursor remains stable during tail streaming');
  const editedPrefix = fridayHistory([
    { role: 'user', content: [{ type: 'text', text: 'changed earlier message' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'partial reply' }] },
  ], 'session-a');
  assert.notEqual(updatedSnapshot[1].prefixRevision, editedPrefix[1].prefixRevision, 'prefix revisions detect transcript resets or earlier edits');
});

test('SDK session periodically refreshes its model catalog and clears the timer on stop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-sdk-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let refreshes = 0;
  let models = [{ provider: 'openai-codex', id: 'gpt-5' }];
  const modelRuntime = { refresh: async () => { refreshes += 1; models = [...models, { provider: 'openai-codex', id: 'gpt-5-new' }]; }, getAvailableSnapshot: () => models };
  const adapter = new FridaySdkSession({ cwd: root, agentDir: join(root, 'config'), dataDir: join(root, 'data'), modelRefreshIntervalMs: 5,
    createModelRuntime: async () => modelRuntime,
    createSession: async () => ({ session: { modelRuntime, messages: [], dispose() {} } }),
  });
  await adapter.start();
  for (let attempt = 0; attempt < 20 && refreshes === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(refreshes > 0);
  assert.deepEqual((await adapter.availableModels()).map((model) => model.id), ['gpt-5', 'gpt-5-new']);
  await adapter.stop();
  const stoppedAt = refreshes;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(refreshes, stoppedAt);
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

test('reopening the current conversation reloads assistant output written by a review runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-sdk-reopen-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const makeAdapter = () => new FridaySdkSession({
    cwd: root,
    agentDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    createModelRuntime: async () => ({}),
    createSession: async ({ sessionManager }) => ({ session: {
      sessionManager,
      sessionFile: sessionManager.getSessionFile(),
      messages: sessionManager.getEntries().filter((entry) => entry.type === 'message').map((entry) => entry.message),
      modelRuntime: { getAvailableSnapshot: () => [] },
      dispose() {},
    } }),
  });
  const viewer = makeAdapter();
  const conversationId = await viewer.newSession();
  viewer.sessionManager.appendMessage({ role: 'user', content: 'Run the delegated task', timestamp: new Date().toISOString() });
  const worker = await viewer.createReviewWorker(conversationId);
  await worker.start();
  await viewer.history(); // capture the viewer's initial on-disk version
  worker.sessionManager.appendMessage({ role: 'assistant', content: 'Verified output after reopen.', timestamp: new Date().toISOString() });
  await viewer.openSession(conversationId);
  const reopened = await viewer.history();
  assert.equal(reopened.filter((message) => message.content === 'Verified output after reopen.').length, 1);

  worker.sessionManager.appendMessage({ role: 'assistant', content: 'Verified output after reconnect.', timestamp: new Date().toISOString() });
  const refreshed = await viewer.history();
  assert.equal(refreshed.filter((message) => message.content === 'Verified output after reopen.').length, 1);
  assert.equal(refreshed.filter((message) => message.content === 'Verified output after reconnect.').length, 1);

  await worker.stop();
  await viewer.stop();
});

test('background review uses the exact saved conversation without switching the active one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'friday-sdk-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = [];
  const adapter = new FridaySdkSession({
    cwd: root,
    agentDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    createModelRuntime: async () => ({}),
    createSession: async (options) => {
      created.push(options);
      const session = {
        sessionManager: options.sessionManager,
        sessionFile: options.sessionManager.getSessionFile(),
        messages: [],
        modelRuntime: { getAvailableSnapshot: () => [] },
        async sendCustomMessage(message) {
          options.sessionManager.appendMessage({ role: 'custom', ...message, timestamp: new Date().toISOString() });
          session.messages.push({ role: 'custom', ...message });
        },
        dispose() {},
      };
      return { session };
    },
  });
  const origin = await adapter.newSession();
  adapter.sessionManager.appendMessage({ role: 'user', content: 'Original task request', timestamp: new Date().toISOString() });
  adapter.sessionManager.appendMessage({ role: 'assistant', content: 'Delegated task', timestamp: new Date().toISOString() });
  const active = await adapter.newSession();
  const activeSession = adapter.session;
  const worker = await adapter.createReviewWorker(origin, {
    listConversations: async () => [],
    getRunStatus: async () => null,
    readConversation: async () => null,
    reportTask: async () => null,
  });
  await worker.start();
  assert.equal(adapter.currentSessionId, active);
  assert.equal(adapter.session, activeSession);
  assert.equal(worker.currentSessionId, origin);
  assert.deepEqual(created.at(-1).tools, ['pi_sessions', 'pi_report_task']);
  assert.match(created.at(-1).resourceLoader.getSystemPrompt(), /Automatic task review/);
  await worker.sendHostTaskEvent({ taskId: 'task', content: 'trusted routing metadata; untrusted Pi output', displayText: 'Reviewing task.' });
  assert.equal(adapter.currentSessionId, active);
  assert.equal(adapter.session, activeSession);
  assert.equal((await worker.history()).at(-1).role, 'event');
  assert.equal((await worker.history()).at(-1).content, 'Reviewing task.');
  await worker.stop();
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
  let created;
  let createContext;
  let renameContext;
  let stopContext;
  let deleteContext;
  const adapter = new FridaySdkSession({
    cwd: root, agentDir: join(root, 'config'), dataDir: join(root, 'data'),
    createModelRuntime: async () => ({ getAvailableSnapshot: () => [] }),
    memory: { readMemory: async () => { memoryRead = true; return '# User preferences\\nConcise answers'; } },
    piControl: {
      listConversations: async () => [],
      createSession: async (input) => { created = input; createContext = { userMessage: input.userMessage, previousAssistantMessage: input.previousAssistantMessage }; return { runId: '123e4567-e89b-12d3-a456-426614174000', name: input.purpose, workspace: root }; },
      renameSession: async (input) => { renameContext = input; return { runId: input.runId, previousName: 'Build task', name: input.name }; },
      sendPrompt: async (input) => { queued = input; return { taskId: '123e4567-e89b-12d3-a456-426614174002', runId: '123e4567-e89b-12d3-a456-426614174000', queueId: '123e4567-e89b-12d3-a456-426614174001', position: 1 }; },
      reportTask: async (value) => value,
      waitForPrompt: async ({ runId, queueId }) => ({ runId, queueId, status: 'completed' }),
      getRunStatus: async () => ({ running: true }),
      readConversation: async ({ runId }) => ({ runId, messages: [] }),
      deleteSession: async (value) => { deleteContext = value; return { deleted: true, runId: value.runId }; },
      stopRun: async (value) => { stopContext = value; return { runId: value.runId, stopped: true }; },
      getStopAuthorizationContext: () => ({ userMessage: 'Please stop the Build task run.' }),
    },
    createSession: async (value) => {
      options = value;
      assert.match(value.resourceLoader.getSystemPrompt(), /You are Friday, the user's personal assistant and work orchestrator/);
      assert.match(value.resourceLoader.getSystemPrompt(), /Friday automatically reviews live terminal events/);
      assert.match(value.resourceLoader.getSystemPrompt(), /pi_sessions with action list/);
      assert.match(value.resourceLoader.getSystemPrompt(), /pi_report_task as completed only when verified/);
      const session = {
        sessionFile: value.sessionManager.getSessionFile(), messages: [], modelRuntime: value.modelRuntime,
        async prompt(message) {
          session.messages.push({ role: 'user', content: message });
          if (message.startsWith('now create a new pi session')) {
            const manageTool = value.customTools.find((tool) => tool.name === 'pi_manage_session');
            await manageTool.execute('tool-call', { action: 'create', purpose: 'friday-ui', domain: 'friday-ui' }, undefined, undefined, undefined);
            session.messages.push({ role: 'assistant', content: 'Created.' });
          } else if (message.startsWith('Please rename') || message.startsWith('rename that session')) {
            const manageTool = value.customTools.find((tool) => tool.name === 'pi_manage_session');
            await manageTool.execute('tool-call', { action: 'rename', runId: '123e4567-e89b-12d3-a456-426614174000', name: message.startsWith('rename that session') ? 'Friday Project 2' : 'friday-ui' }, undefined, undefined, undefined);
            session.messages.push({ role: 'assistant', content: 'Renamed.' });
          } else if (message.startsWith('Please stop')) {
            const stopTool = value.customTools.find((tool) => tool.name === 'pi_stop_run');
            await stopTool.execute('tool-call', { runId: '123e4567-e89b-12d3-a456-426614174000' }, undefined, undefined, undefined);
            session.messages.push({ role: 'assistant', content: 'Stopped.' });
          } else {
            const manageTool = value.customTools.find((tool) => tool.name === 'pi_manage_session');
            await manageTool.execute('tool-call', { action: 'delete', runId: '123e4567-e89b-12d3-a456-426614174000' }, undefined, undefined, undefined);
          }
        },
        dispose() {},
      };
      return { session };
    },
  });
  await adapter.start();
  assert.equal(memoryRead, true);
  assert.match(options.resourceLoader.getSystemPrompt(), /You are Friday, the user's personal assistant and work orchestrator/);
  assert.match(options.resourceLoader.getSystemPrompt(), /Friday automatically reviews live terminal events/);
  assert.match(options.resourceLoader.getSystemPrompt(), /pi_report_task as completed only when verified/);
  const expectedPiTools = ['pi_sessions', 'pi_manage_session', 'pi_send_prompt', 'pi_report_task', 'pi_stop_run'];
  assert.deepEqual(options.tools, expectedPiTools);
  assert.deepEqual(options.customTools.map((tool) => tool.name), expectedPiTools);
  const createRequest = 'now create a new pi session for friday-ui';
  await adapter.chat(createRequest);
  assert.deepEqual(createContext, { userMessage: createRequest, previousAssistantMessage: '' });
  assert.equal(created.purpose, 'friday-ui');
  assert.equal(created.domain, 'friday-ui');
  const renameRequest = 'rename that session Friday Project 2';
  await adapter.chat(renameRequest);
  assert.equal(renameContext.name, 'Friday Project 2');
  assert.equal(renameContext.runId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(renameContext.userMessage, renameRequest);
  assert.deepEqual(renameContext.hostSessionEvents.map(({ type, runId }) => ({ type, runId })), [
    { type: 'created', runId: '123e4567-e89b-12d3-a456-426614174000' },
  ]);
  const sendTool = options.customTools.find((tool) => tool.name === 'pi_send_prompt');
  const result = await sendTool.execute('tool-call', { taskName: 'Inspect this', prompt: 'Objective: inspect this', runId: '123e4567-e89b-12d3-a456-426614174000' }, undefined, undefined, undefined);
  assert.match(result.content[0].text, /Task .* queued.*run.*123e4567/i);
  assert.equal(queued.conversationId, adapter.currentSessionId);
  assert.equal(queued.taskName, 'Inspect this');
  await adapter.chat('Please stop the Build task run.');
  assert.deepEqual(stopContext, { runId: '123e4567-e89b-12d3-a456-426614174000', userMessage: 'Please stop the Build task run.', previousAssistantMessage: 'Renamed.' });
  const deleteRequest = 'Please delete Pi session “Build task”.';
  await adapter.chat(deleteRequest);
  assert.deepEqual(deleteContext, {
    runId: '123e4567-e89b-12d3-a456-426614174000', conversationId: adapter.currentSessionId,
    userMessage: deleteRequest, previousAssistantMessage: 'Stopped.',
  });
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
  assert.deepEqual(options.tools, []);
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
