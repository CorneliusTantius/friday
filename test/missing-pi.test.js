import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppClient } from '../test-support/app-client.js';

const serverPath = new URL('../src/server.js', import.meta.url).pathname;

test('missing Pi gives actionable 404 without blocking notes', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-no-pi-'));
  const fridayHome = join(home, 'friday');
  const oldPiWorkspace = join(home, '.pi', 'workspace');
  await mkdir(join(fridayHome, 'config'), { recursive: true });
  await writeFile(join(fridayHome, 'config', 'config.json'), JSON.stringify({ workspace: oldPiWorkspace }));
  const legacyPiRepoFile = join(home, '.pi', 'repos', 'preserve-me.txt');
  await mkdir(join(home, '.pi', 'repos'), { recursive: true });
  await writeFile(legacyPiRepoFile, 'leave existing Pi files in place');
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [serverPath], {
    cwd: home, env: { ...process.env, FRIDAY_HOME: join(home, 'friday'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PI_COMMAND: join(home, 'no-pi'), PORT: String(port) }, stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(2000)]);
    await rm(home, { recursive: true, force: true });
  });
  const client = createAppClient(`http://127.0.0.1:${port}`);
  const request = client.request;
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await request('/healthz')).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready);
  await client.login();
  assert.deepEqual((await (await request('/api/notes')).json()).notes, []);
  const sessions = await (await request('/api/sessions')).json();
  assert.equal(sessions.workspace, join(fridayHome, 'workspace'));
  assert.equal(JSON.parse(await readFile(join(fridayHome, 'config', 'config.json'), 'utf8')).workspace, join(fridayHome, 'workspace'));
  assert.equal((await request('/api/pi/repos')).status, 404);
  assert.deepEqual((await (await request('/api/repos')).json()).repos, []);
  const { stat } = await import('node:fs/promises');
  assert.equal(await readFile(legacyPiRepoFile, 'utf8'), 'leave existing Pi files in place');
  await assert.rejects(stat(join(home, '.pi', 'workspace', 'repos')));
  assert.ok((await stat(join(home, 'friday', 'workspace', 'repos'))).isDirectory());
  assert.ok((await stat(join(home, 'friday', 'workspace', 'notes'))).isDirectory());
  const piSettings = await request('/api/pi/settings');
  assert.equal(piSettings.status, 404);
  assert.match((await piSettings.json()).error, /Pi is not installed/);
  const response = await request('/api/models');
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /Pi is not installed/);
  const page = await request('/pi-not-installed');
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Install the/);
});
