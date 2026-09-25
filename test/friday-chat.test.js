import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../', import.meta.url).pathname;

test('Friday chat endpoints use an isolated runtime and preserve history across reloads', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-chat-test-'));
  const fakePi = join(dir, 'fake-pi.js');
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  await mkdir(join(dir, 'agent'), { recursive: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await mkdir(join(dir, 'friday'), { recursive: true });
  await writeFile(fakePi, `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.PI_ARGS_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.argv.includes('list')) { process.stdout.write('User packages:\\n'); process.exit(0); }
const rl = readline.createInterface({ input: process.stdin });
let messages = [];
let model = { provider: 'fake', id: 'default', name: 'Default' };
let thinkingLevel = 'off';
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
rl.on('line', line => {
 let req; try { req = JSON.parse(line); } catch { return; }
 const respond = data => send({ type: 'response', id: req.id, command: req.command, success: true, data });
 if (req.type === 'get_state') respond({ model, thinkingLevel, sessionFile: path.join(process.cwd(), 'session.jsonl') });
 else if (req.type === 'get_available_models') respond({ models: [{ provider: 'fake', id: 'default', name: 'Default' }, { provider: 'fake', id: 'alternate', name: 'Alternate' }] });
 else if (req.type === 'get_available_thinking_levels') respond({ levels: ['off', 'low', 'high'] });
 else if (req.type === 'set_model') { model = { provider: req.provider, id: req.modelId, name: 'Alternate' }; respond({}); }
 else if (req.type === 'set_thinking_level') { thinkingLevel = req.level; respond({}); }
 else if (req.type === 'prompt') { messages.push({ role: 'user', content: req.message }); send({ type: 'agent_start' }); send({ type: 'message_start', message: { role: 'assistant' } }); const content = 'Friday: ' + req.message; messages.push({ role: 'assistant', content }); send({ type: 'message_end', message: { role: 'assistant', content } }); send({ type: 'agent_end' }); send({ type: 'agent_settled' }); respond({}); }
 else if (req.type === 'get_messages') respond({ messages });
 else respond({});
});
`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(root, 'src/server.js')], {
    cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PI_COMMAND: fakePi, PI_ARGS_LOG: join(dir, 'pi-args.jsonl'), FRIDAY_HOME: join(dir, 'home'),
      PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(dir, 'sessions'),
      FRIDAY_CHAT_DIR: join(dir, 'friday') }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, options) => fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
  let eventReader;
  t.after(async () => {
    eventReader?.cancel().catch(() => {});
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

  const page = await request('/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="friday-feature" class="feature-layout"/);
  assert.match(html, /id="friday-model"/);
  assert.match(html, /id="friday-thinking-level"/);
  assert.ok(html.indexOf('id="friday-settings-heading"') < html.indexOf('id="runtime-settings-heading"'));
  const script = await request('/friday-chat.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  const status = await request('/api/friday/status');
  assert.equal(status.status, 200);
  const settings = await (await request('/api/settings')).json();
  assert.equal(settings.fridayChat.directory, join(dir, 'friday'));
  assert.equal(settings.fridayChat.sessionsDirectory, join(dir, 'friday', 'sessions'));
  assert.match(settings.fridayChat.sessionPath, /friday/);
  assert.equal(settings.fridayChat.running, true);
  assert.notEqual(settings.workspace, settings.fridayChat.directory);
  const codingModels = await (await request('/api/models')).json();
  assert.equal(codingModels.current.id, 'default');
  const fridayModels = await (await request('/api/friday/models')).json();
  assert.deepEqual(fridayModels.models.map((item) => item.id), ['default', 'alternate']);
  assert.equal(fridayModels.current.id, 'default');
  assert.deepEqual((await (await request('/api/friday/thinking-levels')).json()).levels, ['off', 'low', 'high']);
  const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/friday/model', { provider: 'fake' })).status, 400);
  assert.equal((await post('/api/friday/thinking-level', {})).status, 400);
  const changedModel = await (await post('/api/friday/model', { provider: 'fake', modelId: 'alternate' })).json();
  assert.equal(changedModel.model.id, 'alternate');
  const changedThinking = await (await post('/api/friday/thinking-level', { level: 'high' })).json();
  assert.equal(changedThinking.level, 'high');
  const fridayState = await (await request('/api/friday/status')).json();
  assert.equal(fridayState.model.id, 'alternate');
  assert.equal(fridayState.thinkingLevel, 'high');
  assert.equal((await (await request('/api/models')).json()).current.id, 'default');
  assert.equal((await (await request('/api/thinking-levels')).json()).current, 'off');
  const before = await request('/api/history');
  assert.equal(before.status, 200);
  const historyBefore = await before.json();
  const chat = await request('/api/friday/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'private Friday message' }) });
  assert.equal(chat.status, 200);
  const chatBody = await chat.json();
  assert.match(JSON.stringify(chatBody), /Friday: private Friday message/);

  const fridayHistoryResponse = await request('/api/friday/history');
  assert.equal(fridayHistoryResponse.status, 200);
  const fridayHistory = await fridayHistoryResponse.json();
  assert.match(JSON.stringify(fridayHistory), /private Friday message/);
  assert.doesNotMatch(JSON.stringify(await (await request('/api/history')).json()), /private Friday message/);

  // Reload is another request against the same server/runtime.
  const afterReload = await request('/api/friday/history');
  assert.match(JSON.stringify(await afterReload.json()), /private Friday message/);
  const codingAfter = await (await request('/api/history')).json();
  assert.deepEqual(codingAfter.messages, historyBefore.messages);

  const argsLog = (await (await import('node:fs/promises')).readFile(join(dir, 'pi-args.jsonl'), 'utf8')).trim().split(/\n/).map(JSON.parse);
  const fridaySpawn = argsLog.find(({ cwd }) => cwd === join(dir, 'friday'));
  assert.ok(fridaySpawn, 'Friday Pi should use its separate cwd');
  for (const flag of ['--no-extensions', '--no-skills', '--no-context-files']) assert.ok(fridaySpawn.args.includes(flag), `Friday Pi should receive ${flag}`);
  assert.equal(fridaySpawn.args[fridaySpawn.args.indexOf('--tools') + 1], 'bash,edit,read,write');
  assert.equal(fridaySpawn.args[fridaySpawn.args.indexOf('--session-dir') + 1], join(dir, 'friday', 'sessions'));

  const codingResponse = await request('/api/events/token', { method: 'POST' });
  const fridayResponse = await request('/api/friday/events/token', { method: 'POST' });
  assert.equal(codingResponse.status, 200);
  assert.equal(fridayResponse.status, 200);
  const { token: codingToken } = await codingResponse.json();
  const { token: fridayToken } = await fridayResponse.json();
  const open = async (token) => {
    const response = await request(`/api/events?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    return response.body.getReader();
  };
  const fridayReader = await open(fridayToken);
  const codingReader = await open(codingToken);
  eventReader = fridayReader;
  const firstRuntime = async (reader) => {
    let data = '';
    while (!data.includes('event: runtime')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      data += new TextDecoder().decode(value);
    }
    return data.split('\\n\\n').find((part) => part.includes('event: runtime'));
  };
  const [fridayEvent, codingEvent] = await Promise.race([
    Promise.all([firstRuntime(fridayReader), firstRuntime(codingReader)]),
    delay(3000).then(() => { throw new Error('SSE event timeout'); }),
  ]);
  assert.notEqual(fridayEvent, codingEvent);
  assert.match(fridayEvent, /sessionPath.*friday/);
  // Emit chat activity/status after both streams are attached. Friday must receive
  // both; coding SSE must remain quiet for a bounded interval.
  const fridayEvents = (async () => {
    let data = '';
    while (!data.includes('\"kind\":\"activity\"') || !data.includes('\"kind\":\"status\"')) {
      const { value, done } = await fridayReader.read();
      assert.equal(done, false);
      data += new TextDecoder().decode(value);
    }
    return data;
  })();
  const chatAgain = await request('/api/friday/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'SSE activity' }) });
  assert.equal(chatAgain.status, 200);
  const eventData = await Promise.race([fridayEvents, delay(2000).then(() => { throw new Error('Friday SSE activity/status timeout'); })]);
  assert.match(eventData, /\"kind\":\"activity\"/);
  assert.match(eventData, /\"kind\":\"status\"/);
  const codingRead = codingReader.read();
  const codingResult = await Promise.race([codingRead.then(() => 'event'), delay(150).then(() => 'quiet')]);
  assert.equal(codingResult, 'quiet', 'coding SSE should not receive Friday activity or status');
  await codingReader.cancel();
});

test('Friday chat reopens the latest persisted Pi session after server restart', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-restart-test-'));
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const fridayDir = join(dir, 'friday');
  const sessionFile = join(fridayDir, 'data', 'persisted.jsonl');
  const fakePi = join(dir, 'fake-pi.js');
  await mkdir(join(sessionFile, '..'), { recursive: true });
  await writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'persisted', timestamp: new Date().toISOString(), cwd: join(fridayDir, 'data') }) + '\n' + JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: 'saved Friday message' } }) + '\n');
  await writeFile(fakePi, `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.PI_ARGS_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
rl.on('line', line => { let req; try { req = JSON.parse(line); } catch { return; }
 const respond = data => send({ type: 'response', id: req.id, command: req.command, success: true, data });
 if (req.type === 'get_state') respond({ model: null, thinkingLevel: 'off', sessionFile: path.join(process.cwd(), 'persisted.jsonl') });
 else if (req.type === 'get_messages') respond({ messages: [{ role: 'user', content: 'saved Friday message' }] });
 else respond({});
});
`, { mode: 0o755 });
  const log = join(dir, 'pi-args.jsonl');
  const base = `http://127.0.0.1:${port}`;
  const start = () => spawn(process.execPath, [join(root, 'src/server.js')], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PI_COMMAND: fakePi, PI_ARGS_LOG: log, PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(dir, 'sessions'), FRIDAY_HOME: fridayDir }, stdio: 'ignore' });
  let child;
  const stop = async () => { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(2000)]); child = null; };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const ready = async () => { for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) return; } catch {} await delay(100); } assert.fail('server should start'); };
  child = start(); await ready();
  const history = await fetch(base + '/api/friday/history');
  assert.equal(history.status, 200);
  assert.match(JSON.stringify(await history.json()), /saved Friday message/);
  const codingSessions = await (await import('node:fs/promises')).readdir(join(dir, 'sessions')).catch(() => []);
  assert.equal(codingSessions.length, 0, 'Friday sessions must not use coding session storage');
  await stop();
  child = start(); await ready();
  const reopened = await fetch(base + '/api/friday/history');
  assert.equal(reopened.status, 200);
  assert.match(JSON.stringify(await reopened.json()), /saved Friday message/);
  const launches = (await (await import('node:fs/promises')).readFile(log, 'utf8')).trim().split(/\n/).map(JSON.parse);
  assert.equal(launches.length, 2, 'Friday Pi should launch again after restart');
  assert.equal(launches[0].cwd, join(fridayDir, 'workspace'));
  assert.equal(launches[1].args[launches[1].args.indexOf('--session-dir') + 1], join(fridayDir, 'data'));
  const sessionFlag = launches[1].args.indexOf('--session');
  assert.notEqual(sessionFlag, -1, 'Pi should be started with an existing session');
  assert.match(launches[1].args[sessionFlag + 1], /persisted\.jsonl$/, 'Pi should be started with the persisted latest session');
});

test('Friday chat runs from Friday workspace and stores sessions separately in data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-settings-test-'));
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const { FRIDAY_CHAT_DIR: _unused, ...env } = process.env;
  const child = spawn(process.execPath, [join(root, 'src/server.js')], {
    cwd: dir,
    env: { ...env, HOST: '127.0.0.1', PORT: String(port), PI_COMMAND: '/bin/true', FRIDAY_HOME: join(dir, 'home'), PI_CODING_AGENT_DIR: join(dir, 'agent') },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'server should start');
  const settings = await (await fetch(base + '/api/settings')).json();
  assert.equal(settings.fridayChat.directory, join(dir, 'home', 'workspace'));
  assert.equal(settings.fridayChat.sessionsDirectory, join(dir, 'home', 'data'));
});
