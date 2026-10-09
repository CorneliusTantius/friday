import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiSession } from '../src/pi/pi-session.js';

test('PiSession setSessionName sends a name update through Pi RPC', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-rename-'));
  const script = join(dir, 'fake-pi.js');
  const launcher = join(dir, 'fake-pi');
  const record = join(dir, 'rename.json');
  await writeFile(script, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    rl.on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'get_state') send({ type: 'response', id: request.id, success: true, data: {} });
      if (request.type === 'set_session_name') {
        fs.writeFileSync(process.argv[2], JSON.stringify({ type: request.type, name: request.name }));
        send({ type: 'response', id: request.id, success: true, data: {} });
      }
    });
  `);
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${record}"`);
  await chmod(launcher, 0o755);
  const session = new PiSession({ command: launcher, cwd: dir });
  t.after(async () => { await session.stop(); await rm(dir, { recursive: true, force: true }); });
  await session.setSessionName('friday-ui');
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), { type: 'set_session_name', name: 'friday-ui' });
});

test('queue retries only a rejected prompt after the active Pi run settles and preserves its result', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-queue-busy-'));
  const script = join(dir, 'fake-pi.js');
  const launcher = join(dir, 'fake-pi');
  const accepted = join(dir, 'accepted.json');
  await writeFile(script, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    let deferredContinuation = false;
    const assistantTurn = (text, reply = text) => {
      send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
      send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
      send({ type: 'agent_settled' });
    };
    rl.on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'get_state') send({ type: 'response', id: request.id, success: true, data: {} });
      if (request.type !== 'prompt') return;
      if (request.message === 'current') {
        deferredContinuation = true;
        send({ type: 'response', id: request.id, success: true, data: {} });
        setTimeout(() => {
          assistantTurn('current');
          setTimeout(() => {
            deferredContinuation = false;
            send({ type: 'agent_start' });
            send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'deferred inspection' }] } });
            send({ type: 'agent_settled' });
          }, 40);
        }, 5);
      } else if (request.message === 'queued task' && deferredContinuation) {
        send({ type: 'response', id: request.id, success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
      } else if (request.message === 'queued task') {
        fs.appendFileSync(process.argv[2], 'accepted\\n');
        send({ type: 'response', id: request.id, success: true, data: {} });
        setTimeout(() => assistantTurn('queued task', 'task result'), 5);
      }
    });
  `);
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${accepted}"`);
  await chmod(launcher, 0o755);
  const session = new PiSession({ command: launcher, cwd: dir });
  t.after(async () => { await session.stop(); await rm(dir, { recursive: true, force: true }); });
  const busyStates = [];
  session.on('status', ({ busy }) => busyStates.push(busy));
  const current = session.chat('current');
  const result = new Promise((resolve) => session.once('prompt_queue_result', resolve));
  const queued = session.enqueuePrompt('queued task');
  assert.equal(await current, 'current');
  assert.equal(session.isBusy, true, 'busy remains true while the rejected queue item waits to retry');
  const outcome = await result;
  assert.equal(outcome.id, queued.id, 'completion remains correlated to the original queue job');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result, 'task result');
  assert.ok(busyStates.slice(0, -1).every(Boolean), 'busy never drops between the active run and its queued prompt');
  assert.equal(busyStates.at(-1), false, 'busy clears after all queued work completes');
  assert.equal((await readFile(accepted, 'utf8')).trim(), 'accepted', 'the rejected prompt was not executed twice');
});

test('a queued prompt with no final assistant text is not reported as completed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-queue-empty-'));
  const script = join(dir, 'fake-pi.js');
  const launcher = join(dir, 'fake-pi');
  await writeFile(script, `
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    rl.on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'get_state') send({ type: 'response', id: request.id, success: true, data: {} });
      if (request.type === 'prompt') {
        send({ type: 'response', id: request.id, success: true, data: {} });
        send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: request.message }] } });
        send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: request.message }] } });
        send({ type: 'message_end', message: { role: 'assistant', content: [] } });
        send({ type: 'agent_settled' });
      }
    });
  `);
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}"`);
  await chmod(launcher, 0o755);
  const session = new PiSession({ command: launcher, cwd: dir });
  t.after(async () => { await session.stop(); await rm(dir, { recursive: true, force: true }); });
  const result = new Promise((resolve) => session.once('prompt_queue_result', resolve));
  session.enqueuePrompt('tool-only work');
  const outcome = await result;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /without a final assistant response/);
  assert.equal('result' in outcome, false);
});

test('enqueuePrompt returns immediately and executes prompts FIFO while chat is active', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-queue-'));
  const script = join(dir, 'fake-pi.js');
  const launcher = join(dir, 'fake-pi');
  await writeFile(script, `
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    rl.on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'get_state') send({ type: 'response', id: request.id, success: true, data: {} });
      if (request.type === 'prompt') {
        send({ type: 'response', id: request.id, success: true, data: {} });
        setTimeout(() => {
          send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: request.message }] } });
          send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: request.message }] } });
          send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: request.message }] } });
          send({ type: 'agent_settled' });
        }, 80);
      }
    });
  `);
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}"`);
  await chmod(launcher, 0o755);
  const session = new PiSession({ command: launcher, cwd: dir });
  t.after(async () => { await session.stop(); await rm(dir, { recursive: true, force: true }); });
  await session.start();

  const firstChat = session.chat('current');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = session.enqueuePrompt('one');
  const second = session.enqueuePrompt('two');
  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  assert.equal(session.isBusy, true);
  assert.equal(await firstChat, 'current');

  const results = [];
  session.on('prompt_queue_result', (result) => results.push(result));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('queue timed out')), 2000);
    const check = () => {
      if (results.length === 2) { clearTimeout(timeout); resolve(); }
      else setTimeout(check, 10);
    };
    check();
  });
  assert.deepEqual(results.map((result) => result.result), ['one', 'two']);

  const blocker = session.chat('blocker');
  for (let attempt = 0; attempt < 20 && !session.isBusy; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  session.enqueuePrompt('discard this');
  assert.equal(session.clearPromptQueue(), 1);
  await blocker;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(results[2].cancelled, true);
});
