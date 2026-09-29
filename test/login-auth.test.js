import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppClient } from '../test-support/app-client.js';

const serverPath = new URL('../src/server.js', import.meta.url).pathname;

test('password login protects the app with a memory-only session cookie', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-login-'));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [serverPath], {
    cwd: home,
    env: { ...process.env, HOME: home, FRIDAY_HOME: join(home, '.friday'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(2000)]);
    await rm(home, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const client = createAppClient(base);
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${base}/login`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'server should start');

  const loginPage = await fetch(`${base}/login`);
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /id="password"/);
  assert.match(loginHtml, /id="login-toast"/);
  const loginScript = await fetch(`${base}/login.js`);
  assert.equal(loginScript.status, 200);
  assert.match(await loginScript.text(), /notice.*login-required/s);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const protectedPage = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 303);
  assert.equal(protectedPage.headers.get('location'), '/login');

  const wrongPassword = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.headers.get('set-cookie'), null);

  const login = await client.login();
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Max-Age|Expires=/);
  assert.equal((await client.request('/')).status, 200);
  const appScript = await client.request('/app.js');
  assert.equal(appScript.status, 200);
  assert.match(await appScript.text(), /location\.replace\('\/login\?notice=login-required'\)/);

  const logout = await client.request('/api/logout', { method: 'POST' });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const expiredRequest = await client.request('/api/status');
  assert.equal(expiredRequest.status, 401);
  assert.deepEqual(await expiredRequest.json(), { error: 'Login required' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(failed.status, 401);
  }
  const limited = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
