import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayPiTools } from '../src/friday/friday-pi-tools.js';

const id = '123e4567-e89b-12d3-a456-426614174000';
const taskId = '123e4567-e89b-12d3-a456-426614174002';
const queueId = '123e4567-e89b-12d3-a456-426614174003';
const invoke = (tool, args, signal) => tool.execute('call', args, signal, undefined, undefined);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

function setup() {
  const calls = { list: [], status: [], read: [], create: [], rename: [], profile: [], send: [], report: [], delete: [], stop: [] };
  const contexts = { create: [], rename: [], profile: [], delete: [], stop: [] };
  const tools = createFridayPiTools({
    listConversations: async () => { calls.list.push(true); return [
      { id: 's1', name: 'Build task', domain: 'platform', purpose: 'maintain platform', modified: 'today', messageCount: 4, runId: id, running: true, busy: false, queuedPrompts: 0, expertise: ['Node.js'], responsibilities: ['API'], repositories: ['friday'], capacity: 2, workload: { openTasks: 1 }, tasks: [{ id: taskId, label: 'Add export', status: 'running' }], hiddenField: 'not exposed' },
      { id: 's2', name: 'Unprofiled', modified: 'today', messageCount: 0, runId: '123e4567-e89b-12d3-a456-426614174004' },
    ]; },
    getRunStatus: async (runId) => { calls.status.push(runId); return { runId, exists: false, opening: false, workspace: '/other-workspace', running: false }; },
    readConversation: async (value) => { calls.read.push(value); return { runId: value.runId, messages: [{ role: 'assistant', content: 'Pi reply' }] }; },
    createSession: async (value) => { calls.create.push(value); return { runId: id, name: value.purpose, workspace: '/workspace' }; },
    renameSession: async (value) => { calls.rename.push(value); return { runId: value.runId, previousName: 'Build task', name: value.name }; },
    updateProfile: async (value) => { calls.profile.push(value); return { runId: value.runId, ...value.profile }; },
    sendPrompt: async (value) => { calls.send.push(value); return { taskId, runId: id, queueId, position: 2 }; },
    reportTask: async (value) => { calls.report.push(value); return { id: value.taskId, status: value.status, summary: value.summary }; },
    deleteSession: async (value) => { calls.delete.push(value); return { deleted: true, runId: value.runId }; },
    stopRun: async (value) => { calls.stop.push(value); return { runId: value.runId, stopped: true }; },
    getConversationId: () => 'friday-c1',
    getCreateAuthorizationContext: async () => { contexts.create.push(true); return { userMessage: 'Create a new Pi session for this task.', previousAssistantMessage: '' }; },
    getRenameAuthorizationContext: async () => { contexts.rename.push(true); return { userMessage: 'Rename Build task to friday-ui.' }; },
    getProfileAuthorizationContext: async () => { contexts.profile.push(true); return { userMessage: 'Update the profile for Build task.' }; },
    getDeleteAuthorizationContext: async () => { contexts.delete.push(true); return { userMessage: 'Delete Build task.' }; },
    getStopAuthorizationContext: async () => { contexts.stop.push(true); return { userMessage: 'Stop the Build task run.' }; },
  });
  return { tools, calls, contexts };
}

test('Friday exposes five Pi tools, removes agent-facing wait, and keeps actions discriminated', async () => {
  const { tools, calls, contexts } = setup();
  assert.deepEqual(tools.map(({ name }) => name), [
    'pi_sessions', 'pi_manage_session', 'pi_send_prompt', 'pi_report_task', 'pi_stop_run',
  ]);
  for (const name of ['pi_sessions', 'pi_manage_session']) {
    assert.equal(tools.find((tool) => tool.name === name).parameters.type, 'object');
    assert.equal(tools.find((tool) => tool.name === name).parameters.additionalProperties, false);
  }
  assert.equal(tools[0].parameters.properties.action.anyOf.length, 3);
  assert.equal(tools[1].parameters.properties.action.anyOf.length, 4);

  assert.deepEqual(await invoke(tools[0], { action: 'list' }), text(JSON.stringify([
    { id: 's1', name: 'Build task', domain: 'platform', purpose: 'maintain platform', modified: 'today', messageCount: 4, runId: id, running: true, busy: false, queuedPrompts: 0, expertise: ['Node.js'], responsibilities: ['API'], repositories: ['friday'], capacity: 2, workload: { openTasks: 1 }, tasks: [{ id: taskId, label: 'Add export', status: 'running' }] },
    { id: 's2', name: 'Unprofiled', modified: 'today', messageCount: 0, runId: '123e4567-e89b-12d3-a456-426614174004', expertise: [], responsibilities: [], repositories: [], capacity: 2, workload: { openTasks: 0 }, tasks: [] },
  ])));
  assert.deepEqual(calls.list, [true]);
  assert.deepEqual(await invoke(tools[0], { action: 'status', runId: id }), text({ runId: id, exists: false, opening: false, workspace: '/other-workspace', running: false }));
  assert.deepEqual(calls.status, [id], 'status preserves stale-run and cross-workspace details');
  assert.deepEqual(await invoke(tools[0], { action: 'read', runId: id, limit: 5 }), text({ runId: id, messages: [{ role: 'assistant', content: 'Pi reply' }] }));
  assert.deepEqual(calls.read, [{ runId: id, limit: 5, taskId: undefined, conversationId: 'friday-c1' }]);
});

test('discriminated query and management actions reject invalid, mixed, and extra parameters before dispatch', async () => {
  const { tools, calls, contexts } = setup();
  const sessions = tools[0];
  const manage = tools[1];
  for (const invalid of [
    {}, { action: 'unknown' }, { action: 'list', runId: id },
    { action: 'status' }, { action: 'status', runId: 'not-a-uuid' },
    { action: 'read', runId: id, limit: 11 }, { action: 'read', runId: id, extra: true }, { action: 'list', taskId },
  ]) await assert.rejects(invoke(sessions, invalid), /Invalid pi_sessions parameters/);
  assert.deepEqual(calls.list, []);
  assert.deepEqual(calls.status, []);
  assert.deepEqual(calls.read, []);

  for (const invalid of [
    {}, { action: 'unknown' }, { action: 'create' },
    { action: 'create', purpose: 'new', runId: id },
    { action: 'create', purpose: 'new', domain: 'x'.repeat(81) },
    { action: 'rename', name: 'new-name' },
    { action: 'rename', runId: 'not-a-uuid', name: 'new-name' },
    { action: 'rename', runId: id, name: 'new-name', purpose: 'extra' },
    { action: 'delete', runId: id, name: 'extra' },
    { action: 'profile', runId: id },
    { action: 'profile', runId: id, expertise: [], responsibilities: [], repositories: [], capacity: 9 },
  ]) await assert.rejects(invoke(manage, invalid), /Invalid pi_manage_session parameters/);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.rename, []);
  assert.deepEqual(calls.delete, []);
  assert.deepEqual(calls.profile, []);
  assert.deepEqual(contexts, { create: [], rename: [], profile: [], delete: [], stop: [] });
});

test('manage actions preserve distinct current-user authorization contexts and never select sessions', async () => {
  const { tools, calls, contexts } = setup();
  const manage = tools[1];
  assert.deepEqual(await invoke(manage, { action: 'create', purpose: 'this task', domain: 'platform' }), text({ runId: id, name: 'this task', workspace: '/workspace' }));
  assert.deepEqual(await invoke(manage, { action: 'rename', runId: id, name: 'friday-ui' }), text({ runId: id, previousName: 'Build task', name: 'friday-ui' }));
  const profile = { expertise: ['Node.js'], responsibilities: ['API'], repositories: ['friday'], capacity: 2 };
  assert.deepEqual(await invoke(manage, { action: 'profile', runId: id, ...profile }), text({ runId: id, ...profile }));
  assert.deepEqual(await invoke(manage, { action: 'delete', runId: id }), text({ deleted: true, runId: id }));
  assert.deepEqual(calls.create, [{ purpose: 'this task', domain: 'platform', userMessage: 'Create a new Pi session for this task.', previousAssistantMessage: '' }]);
  assert.deepEqual(calls.rename, [{ runId: id, name: 'friday-ui', userMessage: 'Rename Build task to friday-ui.' }]);
  assert.deepEqual(calls.profile, [{ runId: id, profile, userMessage: 'Update the profile for Build task.' }]);
  assert.deepEqual(calls.delete, [{ runId: id, conversationId: 'friday-c1', userMessage: 'Delete Build task.' }]);
  assert.deepEqual(contexts, { create: [true], rename: [true], profile: [true], delete: [true], stop: [] });
});

test('send, report, and stop remain separate with explicit IDs and strict arguments', async () => {
  const { tools, calls, contexts } = setup();
  const send = tools[2];
  const report = tools[3];
  const stop = tools[4];

  assert.match(send.description, /explicitly selected.*exact runId/i);
  assert.match(send.description, /returns immediately/i);
  for (const invalid of [
    { taskName: 'work', prompt: 'Objective', runId: undefined },
    { taskName: 'work', prompt: 'Objective' },
    { taskName: 'work', prompt: 'Objective', runId: 'bad' },
    { taskName: 'work', prompt: 'Objective', runId: id, extra: true },
  ]) await assert.rejects(invoke(send, invalid), /Invalid pi_send_prompt parameters/);
  assert.deepEqual(calls.send, [], 'missing/invalid runId never falls back to the linked conversation');
  assert.deepEqual(await invoke(send, { taskName: 'Add export', prompt: 'Objective: ...', runId: id }), text(`Task ${taskId} queued for run ${id} with queueId ${queueId} (queue position 2). Pi completion is not awaited.`));
  assert.deepEqual(calls.send, [{ taskName: 'Add export', prompt: 'Objective: ...', runId: id, conversationId: 'friday-c1' }]);

  assert.match(report.description, /reading and reviewing/);
  assert.deepEqual(await invoke(report, { taskId, status: 'completed', summary: 'Checks passed.' }), text({ id: taskId, status: 'completed', summary: 'Checks passed.' }));
  assert.deepEqual(calls.report, [{ taskId, status: 'completed', summary: 'Checks passed.', conversationId: 'friday-c1' }]);
  await assert.rejects(invoke(report, { taskId, status: 'reviewing', summary: 'not final' }), /Invalid pi_report_task parameters/);
  await assert.rejects(invoke(report, { taskId, status: 'completed', summary: 'ok', runId: id }), /Invalid pi_report_task parameters/);

  assert.match(stop.description, /current user explicitly asks/);
  assert.deepEqual(await invoke(stop, { runId: id }), text({ runId: id, stopped: true }));
  assert.deepEqual(calls.stop, [{ runId: id, userMessage: 'Stop the Build task run.' }]);
  assert.deepEqual(contexts.stop, [true]);
});
