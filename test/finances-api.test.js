import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppClient } from '../test-support/app-client.js';

const serverPath = new URL('../src/server.js', import.meta.url).pathname;

test('financial tracker API supports persistent transaction CRUD and serves its UI', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-finances-api-'));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [serverPath], {
    cwd: home,
    env: { ...process.env, HOME: home, FRIDAY_HOME: join(home, '.friday'), PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(2000)]);
    await rm(home, { recursive: true, force: true });
  });
  const client = createAppClient(`http://127.0.0.1:${port}`);
  const request = client.request;
  let ready = false;
  for (let index = 0; index < 50; index += 1) {
    try { if ((await request('/healthz')).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'server should start');
  await client.login();
  const page = await (await request('/')).text();
  assert.match(page, /id="finances-feature"/);
  assert.match(page, /data-feature="finances"/);
  assert.match(page, /<option value="1" selected>Past 1 month<\/option>/);
  assert.match(page, /<option value="3">Past 3 months<\/option>/);
  assert.match(page, /<option value="6">Past 6 months<\/option>/);
  assert.match(page, /<option value="12">Past 12 months<\/option>/);
  assert.equal((await (await request('/styles.css')).text()).includes('.finance-page'), true);
  const create = await request('/api/finances', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'expense', amount: '35000', date: '2026-09-27', category: 'Food', description: 'Coffee' }),
  });
  assert.equal(create.status, 201);
  const { entry } = await create.json();
  assert.equal(entry.amount, 35000);
  const invalid = await request('/api/finances', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'expense', amount: '0', date: '2026-09-27', category: 'Food', description: '' }),
  });
  assert.equal(invalid.status, 400);
  const update = await request(`/api/finances/${entry.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '42500', description: 'Tea' }),
  });
  assert.equal((await update.json()).entry.amount, 42500);
  assert.equal((await (await request('/api/finances')).json()).entries[0].description, 'Tea');
  const remove = await request(`/api/finances/${entry.id}`, { method: 'DELETE' });
  assert.equal(remove.status, 204);
  assert.deepEqual((await (await request('/api/finances')).json()).entries, []);
  assert.equal(JSON.parse(await readFile(join(home, '.friday', 'data', 'finances.json'), 'utf8')).length, 0);
});
