import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppClient, testAppPassword } from '../test-support/app-client.js';

const root = new URL('../', import.meta.url).pathname;

test('Friday SDK runtime is isolated from the coding Pi runtime', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-chat-test-'));
  const fakePi = join(dir, 'fake-pi.js');
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  await mkdir(join(dir, 'agent'), { recursive: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await mkdir(join(dir, 'friday'), { recursive: true });
  const managedRepos = join(dir, 'home', 'workspace', 'repos');
  await mkdir(join(managedRepos, 'repo-a', '.git'), { recursive: true });
  await mkdir(join(managedRepos, 'repo-b', '.git'), { recursive: true });
  await writeFile(fakePi, `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--' + process.cwd().replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--');
fs.mkdirSync(sessionRoot, { recursive: true });
let sessionFile = path.join(sessionRoot, Date.now() + '_' + randomUUID() + '.jsonl');
const sessionArg = process.argv.indexOf('--session');
if (sessionArg >= 0) sessionFile = process.argv[sessionArg + 1];
fs.appendFileSync(process.env.PI_ARGS_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.argv.includes('list')) { process.stdout.write('User packages:\\n'); process.exit(0); }
const rl = readline.createInterface({ input: process.stdin });
let messages = [];
let model = { provider: 'fake', id: 'default', name: 'Default' };
let thinkingLevel = 'off';
let activeAbort = null;
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
rl.on('line', line => {
 let req; try { req = JSON.parse(line); } catch { return; }
 const respond = data => send({ type: 'response', id: req.id, command: req.command, success: true, data });
 if (req.type === 'get_state') respond({ model, thinkingLevel, sessionFile });
 else if (req.type === 'switch_session') {
  sessionFile = req.sessionPath;
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\\n');
  respond({ cancelled: false });
 }
 else if (req.type === 'get_session_stats') respond({ contextUsage: { tokens: 25000, contextWindow: 100000, percent: 25 } });
 else if (req.type === 'get_available_models') respond({ models: [{ provider: 'fake', id: 'default', name: 'Default' }, { provider: 'fake', id: 'alternate', name: 'Alternate' }] });
 else if (req.type === 'get_available_thinking_levels') respond({ levels: ['off', 'low', 'high'] });
 else if (req.type === 'set_model') { model = { provider: req.provider, id: req.modelId, name: 'Alternate' }; respond({}); }
 else if (req.type === 'set_thinking_level') { thinkingLevel = req.level; respond({}); }
 else if (req.type === 'prompt') {
  messages.push({ role: 'user', content: req.message });
  if (req.message === 'compaction summary test') messages.push({ role: 'compactionSummary', summary: 'The earlier implementation plan and decisions.', tokensBefore: 90000, timestamp: Date.now() });
  send({ type: 'agent_start' }); send({ type: 'message_start', message: { role: 'assistant' } });
  const finish = () => { if (activeAbort) clearTimeout(activeAbort.timer); activeAbort = null; const content = 'Friday: ' + req.message; messages.push({ role: 'assistant', content }); send({ type: 'message_end', message: { role: 'assistant', content } }); send({ type: 'agent_end' }); send({ type: 'agent_settled' }); respond({}); };
  if (req.message === 'long-running test') { const timer = setTimeout(finish, 2500); activeAbort = { timer, finish }; } else finish();
 }
 else if (req.type === 'abort') { activeAbort?.finish(); respond({}); }
 else if (req.type === 'get_messages') respond({ messages });
 else respond({});
});
`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(root, 'src/server.js')], {
    cwd: dir, env: { ...process.env, FRIDAY_APP_PASSWORD: testAppPassword, HOME: dir, HOST: '127.0.0.1', PORT: String(port), PI_COMMAND: fakePi, PI_ARGS_LOG: join(dir, 'pi-args.jsonl'), FRIDAY_HOME: join(dir, 'home'),
      PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(dir, 'sessions'),
      FRIDAY_CHAT_DIR: join(dir, 'friday') }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const client = createAppClient(base, 5000);
  const request = client.request;
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
    await rm(dir, { recursive: true, force: true });
  });

  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await request('/healthz')).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'server should start');
  await client.login();

  const page = await request('/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="friday-feature" class="feature-layout friday-layout"/);
  assert.match(html, /id="friday-model"/);
  assert.match(html, /id="friday-thinking-level"/);
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/friday-logo\.svg"/);
  const favicon = await request('/friday-logo.svg');
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await favicon.text(), /<text[^>]*>Fr<\/text>/);
  assert.ok(html.indexOf('id="friday-settings-heading"') < html.indexOf('id="runtime-settings-heading"'));
  const script = await request('/friday-chat.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const sessionCards = await request('/friday-pi-session-cards.js');
  assert.equal(sessionCards.status, 200, 'the app session-card module must be served for app.js startup');
  assert.match(sessionCards.headers.get('content-type'), /javascript/);
  assert.match(await sessionCards.text(), /createFridayPiSessionCards/);
  const markdown = await request('/markdown.js');
  assert.equal(markdown.status, 200, 'the app renderer module must be served for app.js startup');
  assert.match(markdown.headers.get('content-type'), /javascript/);
  assert.match(await markdown.text(), /export function renderMarkdown/);
  const dashboardFormat = await request('/dashboard-format.js');
  assert.equal(dashboardFormat.status, 200, 'dashboard formatting module must be served for app.js startup');
  assert.match(dashboardFormat.headers.get('content-type'), /javascript/);
  const highlighter = await request('/highlight.min.js');
  assert.equal(highlighter.status, 200, 'the existing Pi-bundled highlighter is served locally');
  assert.match(highlighter.headers.get('content-type'), /javascript/);
  assert.match(await highlighter.text(), /hljs/);

  const memoryGraphResponse = await request('/api/friday/memory/graph');
  assert.equal(memoryGraphResponse.status, 200);
  assert.deepEqual(await memoryGraphResponse.json(), { nodes: [], edges: [], totalDailyNotes: 0, truncated: false });
  const status = await request('/api/friday/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).delegatedTask, null, 'status exposes the conversation-scoped delegated task when present');
  const piStatus = await (await request('/api/status')).json();
  assert.deepEqual(piStatus.contextUsage, { tokens: 25000, contextWindow: 100000, percent: 25 });
  const safeWorkspace = piStatus.workspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  const scopedSessions = join(dir, 'agent', 'sessions', `--${safeWorkspace}--`);
  await mkdir(scopedSessions, { recursive: true });
  const sessionContents = (id, cwd) => [
    JSON.stringify({ type: 'session', id, cwd, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: id } }),
  ].join('\n') + '\n';
  await writeFile(join(scopedSessions, 'selected-workspace.jsonl'), sessionContents('selected-workspace', piStatus.workspace));
  await writeFile(join(dir, 'sessions', 'legacy-flat.jsonl'), sessionContents('legacy-flat', piStatus.workspace));
  await writeFile(join(dir, 'sessions', 'other-workspace.jsonl'), sessionContents('other-workspace', join(dir, 'other-workspace')));
  const listedSessions = await (await request('/api/sessions')).json();
  assert.deepEqual(listedSessions.sessions.map(({ id }) => id).sort(), ['legacy-flat', 'selected-workspace'], 'list configured flat and workspace-scoped sessions, filtering by workspace');
  assert.ok(listedSessions.sessions.every(({ runId }) => /^[0-9a-f-]{36}$/i.test(runId)), 'sessions expose stable server-managed run IDs');
  const fridayPiConversations = await (await request('/api/friday/pi-conversations')).json();
  assert.deepEqual(fridayPiConversations.sessions.map(({ id }) => id).sort(), ['legacy-flat', 'selected-workspace']);
  assert.deepEqual(fridayPiConversations.sessions.map(({ runId }) => runId).sort(), listedSessions.sessions.map(({ runId }) => runId).sort(), 'Friday panel sees the same stable run IDs');
  const selectedPiConversation = fridayPiConversations.sessions.find(({ id }) => id === 'selected-workspace');
  assert.equal(selectedPiConversation.running, false, 'a saved session without an open runtime is reported as saved');
  assert.equal(selectedPiConversation.opening, false);
  assert.deepEqual(selectedPiConversation.availableRepositories, ['repo-a', 'repo-b']);
  assert.deepEqual(selectedPiConversation.visibleRepositories, ['repo-a', 'repo-b'], 'unconfigured sessions default to all managed repositories visible');
  assert.deepEqual(fridayPiConversations.sessions.find(({ id }) => id === 'legacy-flat').visibleRepositories, ['repo-a', 'repo-b'], 'legacy sessions are visible by default without a stored override');
  const profileResponse = await request(`/api/friday/pi-conversations/${selectedPiConversation.runId}/profile`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expertise: ['Node.js'], responsibilities: ['API ownership'], repositories: ['friday'], capacity: 2 }),
  });
  assert.equal(profileResponse.status, 200);
  const profiledSessions = await (await request('/api/friday/pi-conversations')).json();
  const profiled = profiledSessions.sessions.find(({ runId }) => runId === selectedPiConversation.runId);
  assert.deepEqual(profiled.expertise, ['Node.js']);
  assert.deepEqual(profiled.responsibilities, ['API ownership']);
  assert.deepEqual(profiled.repositories, ['friday']);
  assert.equal(profiled.capacity, 2);
  assert.deepEqual(profiled.workload, { queued: 0, running: 0, reviewing: 0, unknown: 0, openTasks: 0 });
  const visibilityUrl = `/api/friday/pi-conversations/${selectedPiConversation.runId}/repository-visibility`;
  const hideRepo = await request(visibilityUrl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenRepositories: ['repo-b'] }),
  });
  assert.equal(hideRepo.status, 200);
  const afterHide = await (await request('/api/friday/pi-conversations')).json();
  const hiddenSession = afterHide.sessions.find(({ runId }) => runId === selectedPiConversation.runId);
  assert.deepEqual(hiddenSession.visibleRepositories, ['repo-a']);
  assert.deepEqual(hiddenSession.repositories, ['friday'], 'visibility saves do not change staff-fit profile metadata');
  assert.deepEqual(afterHide.sessions.find(({ id }) => id === 'legacy-flat').visibleRepositories, ['repo-a', 'repo-b'], 'visibility is isolated to the exact run');
  const recheckRepo = await request(visibilityUrl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenRepositories: [] }),
  });
  assert.equal(recheckRepo.status, 200);
  const afterRecheck = await (await request('/api/friday/pi-conversations')).json();
  assert.deepEqual(afterRecheck.sessions.find(({ runId }) => runId === selectedPiConversation.runId).visibleRepositories, ['repo-a', 'repo-b']);
  assert.deepEqual(afterRecheck.sessions.find(({ runId }) => runId === selectedPiConversation.runId).repositories, ['friday']);
  const selectedPiResponse = await request('/api/session/select', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Friday-Session': 'friday-pi-status-test' },
    body: JSON.stringify({ cwd: piStatus.workspace, path: selectedPiConversation.path }),
  });
  assert.equal(selectedPiResponse.status, 200);
  const refreshedPiConversations = await (await request('/api/friday/pi-conversations')).json();
  const openedPiConversation = refreshedPiConversations.sessions.find(({ id }) => id === 'selected-workspace');
  assert.equal(openedPiConversation.runId, selectedPiConversation.runId);
  assert.equal(openedPiConversation.running, true, 'a server-opened but idle Pi session is reported as open');
  assert.equal(openedPiConversation.busy, false, 'idle open status is distinct from a running prompt');
  assert.equal(openedPiConversation.queuedPrompts, 0);
  const piStatusHeaders = { 'Content-Type': 'application/json', 'X-Friday-Session': 'friday-pi-status-test' };
  const piLongChat = request('/api/chat', {
    method: 'POST', headers: piStatusHeaders, body: JSON.stringify({ message: 'long-running test' }),
  });
  let piBusy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    piBusy = (await (await request('/api/status', { headers: piStatusHeaders })).json()).busy;
    if (piBusy) break;
    await delay(20);
  }
  assert.equal(piBusy, true, 'the selected Pi runtime reports busy while generating');
  const busyPiConversations = await (await request('/api/friday/pi-conversations')).json();
  const busyPiConversation = busyPiConversations.sessions.find(({ id }) => id === 'selected-workspace');
  assert.equal(busyPiConversation.running, true);
  assert.equal(busyPiConversation.busy, true, 'the Pi conversation list distinguishes generating from open/idle');
  const piAbortResponse = await request('/api/abort', { method: 'POST', headers: piStatusHeaders });
  assert.equal(piAbortResponse.status, 200);
  assert.equal((await piAbortResponse.json()).aborted, true);
  assert.equal((await piLongChat).status, 200);
  const settings = await (await request('/api/settings')).json();
  assert.equal(settings.fridayChat.directory, join(dir, 'friday'));
  assert.equal(settings.fridayChat.sessionsDirectory, join(dir, 'friday', 'sessions'));
  assert.match(settings.fridayChat.sessionPath, /friday/);
  assert.equal(settings.fridayChat.running, true);
  assert.notEqual(settings.workspace, settings.fridayChat.directory);
  const codingModels = await (await request('/api/models')).json();
  assert.equal(codingModels.current.id, 'default');
  const fridayModelsResponse = await request('/api/friday/models');
  assert.equal(fridayModelsResponse.status, 200);
  assert.ok(Array.isArray((await fridayModelsResponse.json()).models));
  const fridayLevelsResponse = await request('/api/friday/thinking-levels');
  assert.equal(fridayLevelsResponse.status, 200);
  assert.ok(Array.isArray((await fridayLevelsResponse.json()).levels));
  const fridayState = await (await request('/api/friday/status')).json();
  assert.equal(fridayState.running, true);
  assert.equal(fridayState.canAbort, false);
  assert.equal(fridayState.contextUsage, null);
  assert.equal((await (await request('/api/models')).json()).current.id, 'default');
  assert.equal((await (await request('/api/thinking-levels')).json()).current, 'off');
  const fridayHistory = await request('/api/friday/history');
  assert.equal(fridayHistory.status, 200);
  const emptySnapshot = await fridayHistory.json();
  assert.deepEqual(emptySnapshot.messages, []);
  const emptyCursor = await (await request(`/api/friday/history?sessionId=${encodeURIComponent(emptySnapshot.sessionId)}`)).json();
  assert.deepEqual(emptyCursor.messages, [], 'an unchanged empty transcript also returns no content');
  assert.equal(emptyCursor.unchanged, true);
  const initialFridaySessions = await (await request('/api/friday/sessions')).json();
  assert.equal(initialFridaySessions.sessions.length, 1);
  const createdFriday = await request('/api/friday/sessions', { method: 'POST' });
  assert.equal(createdFriday.status, 200);
  const { id: createdFridayId } = await createdFriday.json();
  const renamedFriday = await request(`/api/friday/sessions/${createdFridayId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Planning' }),
  });
  assert.equal(renamedFriday.status, 200);
  assert.equal((await renamedFriday.json()).name, 'Planning');
  const currentFriday = await (await request('/api/friday/sessions')).json();
  assert.equal(currentFriday.currentSession, createdFridayId);
  const deletedFriday = await request(`/api/friday/sessions/${createdFridayId}`, { method: 'DELETE' });
  assert.equal(deletedFriday.status, 200);
  assert.notEqual((await deletedFriday.json()).currentSession, createdFridayId);
  assert.equal((await request('/api/friday/sessions/invalid-id/open', { method: 'POST' })).status, 404);
  assert.equal((await request('/api/friday/abort', { method: 'POST' })).status, 409);
  const historyBefore = await (await request('/api/history')).json();
  assert.deepEqual(historyBefore.messages, []);
  const codingAfter = await (await request('/api/history')).json();
  assert.deepEqual(codingAfter.messages, historyBefore.messages);

  const argsLog = (await (await import('node:fs/promises')).readFile(join(dir, 'pi-args.jsonl'), 'utf8')).trim().split(/\n/).map(JSON.parse);
  assert.ok(argsLog.some(({ cwd }) => cwd === piStatus.workspace), 'coding Pi should use the selected coding workspace');
  assert.ok(!argsLog.some(({ cwd }) => cwd === join(dir, 'friday')), 'Friday Chat should not spawn the Pi CLI');

  const resetResponse = await request('/api/session/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: piStatus.workspace }),
  });
  assert.equal(resetResponse.status, 200);
  const resetSession = await resetResponse.json();
  assert.ok(resetSession.sessionPath);
  assert.match(resetSession.runId, /^[0-9a-f-]{36}$/i);
  const resetSessionFile = await (await import('node:fs/promises')).readFile(resetSession.sessionPath, 'utf8');
  assert.equal(JSON.parse(resetSessionFile.split('\n')[0]).cwd, piStatus.workspace);
  const sessionsAfterReset = await (await request(`/api/sessions?cwd=${encodeURIComponent(piStatus.workspace)}`)).json();
  assert.ok(sessionsAfterReset.sessions.some((session) => session.path === resetSession.sessionPath), 'new empty session is saved and listed immediately');
  const compactHeaders = { 'X-Friday-Session': resetSession.runtimeId };
  const compactPrompt = await request('/api/chat', { method: 'POST', headers: { ...compactHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'compaction summary test' }) });
  assert.equal(compactPrompt.status, 200);
  const compactHistory = await (await request('/api/history', { headers: compactHeaders })).json();
  assert.ok(compactHistory.messages.some((message) => message.role === 'compaction' && message.content === 'The earlier implementation plan and decisions.'));

  const fridayEventToken = await request('/api/friday/events/token', { method: 'POST' });
  const piEventToken = await request('/api/events/token', { method: 'POST' });
  assert.equal(fridayEventToken.status, 404, 'Friday updates use polling instead of SSE');
  assert.equal(piEventToken.status, 404, 'Pi agent updates use polling instead of SSE');

  const codingLongChat = request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'long-running test' }) });
  let codingBusy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    codingBusy = (await (await request('/api/status')).json()).canAbort;
    if (codingBusy) break;
    await delay(20);
  }
  assert.equal(codingBusy, true, 'Pi should expose abort while responding');
  const codingAbort = await request('/api/abort', { method: 'POST' });
  assert.equal(codingAbort.status, 200);
  assert.equal((await codingAbort.json()).aborted, true);
  assert.equal((await codingLongChat).status, 200);
  assert.equal((await (await request('/api/status')).json()).busy, false);

  const startupHeaders = { 'X-Friday-Session': 'abort-during-startup' };
  const startupChat = request('/api/chat', { method: 'POST', headers: { ...startupHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'long-running test' }) });
  let startupBusy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    startupBusy = (await (await request('/api/status', { headers: startupHeaders })).json()).canAbort;
    if (startupBusy) break;
    await delay(20);
  }
  assert.equal(startupBusy, true, 'a newly starting Pi session should be abortable');
  const startupAbort = await request('/api/abort', { method: 'POST', headers: startupHeaders });
  assert.equal(startupAbort.status, 200);
  assert.equal((await startupAbort.json()).aborted, true);
  assert.equal((await startupChat).status, 200);

  const originalStatus = await (await request('/api/status')).json();
  const activeChat = request('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'long-running test' }),
  });
  let busy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    busy = (await (await request('/api/status')).json()).busy;
    if (busy) break;
    await delay(20);
  }
  assert.equal(busy, true, 'the original session should be working before reset');
  const reset = await request('/api/session/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(reset.status, 200);
  const { runtimeId: newRuntimeId } = await reset.json();
  assert.notEqual(newRuntimeId, 'default', 'new session should get a separate runtime');
  const preservedStatus = await (await request('/api/status', { headers: { 'X-Friday-Session': 'default' } })).json();
  assert.equal(preservedStatus.piRunning, true, 'the previous runtime should stay running');
  assert.equal(preservedStatus.busy, true, 'the previous task should continue running');
  assert.equal(preservedStatus.sessionPath, originalStatus.sessionPath, 'the previous runtime should keep its session');
  const newHistory = await request('/api/history', { headers: { 'X-Friday-Session': newRuntimeId } });
  assert.equal(newHistory.status, 200);
  assert.deepEqual((await newHistory.json()).messages, [], 'the new runtime should start with empty history');
  assert.equal((await activeChat).status, 200, 'the original task should finish normally');
});

test('Friday SDK resumes the latest saved Friday transcript after restart', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-restart-test-'));
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const fridayDir = join(dir, 'friday');
  const fridayWorkspace = join(fridayDir, 'workspace');
  const sessionFile = join(fridayDir, 'data', 'persisted.jsonl');
  await mkdir(join(fridayDir, 'data'), { recursive: true });
  await writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'persisted', timestamp: new Date().toISOString(), cwd: fridayWorkspace }) + '\n' + JSON.stringify({ type: 'message', id: 'message-1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'saved Friday message' } }) + '\n' + JSON.stringify({ type: 'message', id: 'message-2', parentId: 'message-1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'saved Friday reply' } }) + '\n');
  const base = `http://127.0.0.1:${port}`;
  const client = createAppClient(base);
  const start = () => spawn(process.execPath, [join(root, 'src/server.js')], {
    cwd: dir,
    env: { ...process.env, FRIDAY_APP_PASSWORD: testAppPassword, HOME: dir, HOST: '127.0.0.1', PORT: String(port), PI_COMMAND: join(dir, 'missing-pi'), FRIDAY_HOME: fridayDir, PI_CODING_AGENT_DIR: join(dir, 'agent') },
    stdio: 'ignore',
  });
  let child;
  const stop = async () => { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(2000)]); child = null; };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const ready = async () => { for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) return; } catch {} await delay(100); } assert.fail('server should start'); };
  child = start(); await ready();
  await client.login();
  let history = await client.request('/api/friday/history');
  assert.equal(history.status, 200);
  const initialHistory = await history.json();
  assert.match(JSON.stringify(initialHistory), /saved Friday message/);
  assert.equal(initialHistory.reset, true);
  assert.equal(initialHistory.messages[0].sequence, 0);
  assert.equal(typeof initialHistory.messages[0].id, 'string');
  assert.equal(initialHistory.messages.length, 2);
  const firstCursor = initialHistory.messages[0];
  const latestCursor = initialHistory.messages.at(-1);
  const cursorPath = (cursor) => `/api/friday/history?sessionId=${encodeURIComponent(initialHistory.sessionId)}&afterId=${encodeURIComponent(cursor.id)}&afterRevision=${encodeURIComponent(cursor.revision)}&afterPrefix=${encodeURIComponent(cursor.prefixRevision)}`;
  const incrementalHistory = await (await client.request(cursorPath(firstCursor))).json();
  assert.deepEqual(incrementalHistory.messages.map(({ id }) => id), [latestCursor.id], 'a cursor receives only the newer message');
  assert.equal(incrementalHistory.incremental, true);
  const unchangedHistory = await (await client.request(cursorPath(latestCursor))).json();
  assert.deepEqual(unchangedHistory.messages, [], 'unchanged polls return no transcript messages');
  assert.equal(unchangedHistory.unchanged, true);
  assert.equal((await (await client.request('/api/friday/history?full=1')).json()).messages.length, 2, 'full refresh remains available');
  const switchedHistory = await (await client.request(`/api/friday/history?sessionId=other-session&afterId=${encodeURIComponent(latestCursor.id)}`)).json();
  assert.equal(switchedHistory.reset, true, 'a mismatched session cursor receives a full snapshot');
  assert.equal(switchedHistory.messages.length, 2);
  const resetHistory = await (await client.request(cursorPath(latestCursor).replace(/afterPrefix=[^&]+/, 'afterPrefix=stale-prefix'))).json();
  assert.equal(resetHistory.reset, true, 'an edited or compacted transcript prefix invalidates the cursor safely');
  assert.equal(resetHistory.messages.length, 2);
  await stop();
  child = start(); await ready();
  await client.login();
  history = await client.request(cursorPath(latestCursor));
  assert.equal(history.status, 200);
  const afterRestart = await history.json();
  assert.equal(afterRestart.reset, false, 'the same saved session retains its cursor after restart');
  assert.deepEqual(afterRestart.messages, []);
  const status = await (await client.request('/api/friday/status')).json();
  assert.match(status.sessionPath, /persisted\.jsonl$/);
});

test('Friday chat runs from Friday workspace and stores sessions separately in data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-settings-test-'));
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const { FRIDAY_CHAT_DIR: _unused, ...env } = process.env;
  const child = spawn(process.execPath, [join(root, 'src/server.js')], {
    cwd: dir,
    env: { ...env, FRIDAY_APP_PASSWORD: testAppPassword, HOST: '127.0.0.1', PORT: String(port), PI_COMMAND: '/bin/true', FRIDAY_HOME: join(dir, 'home'), PI_CODING_AGENT_DIR: join(dir, 'agent') },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const client = createAppClient(base);
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await client.request('/healthz', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'server should start');
  await client.login();
  const settings = await (await client.request('/api/settings')).json();
  assert.equal(settings.fridayChat.directory, join(dir, 'home', 'workspace'));
  assert.equal(settings.fridayChat.sessionsDirectory, join(dir, 'home', 'data'));
});
