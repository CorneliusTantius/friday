import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppClient, testAppPassword } from '../test-support/app-client.js';

const serverPath = new URL('../src/server.js', import.meta.url).pathname;

test('Friday refuses to start without a non-empty app password', async (t) => {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, FRIDAY_APP_PASSWORD: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(stderr, /Set FRIDAY_APP_PASSWORD to a non-empty value/);
});

test('password login protects the app with a memory-only session cookie', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-login-'));
  const legacyCalendarToken = join(home, '.friday', 'data', 'socials', 'calendar', 'auth.json');
  await mkdir(join(legacyCalendarToken, '..'), { recursive: true, mode: 0o700 });
  const existingCalendarToken = '{"refreshToken":"keep-existing-token"}\n';
  await writeFile(legacyCalendarToken, existingCalendarToken, { mode: 0o600 });
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [serverPath], {
    cwd: home,
    env: { ...process.env, FRIDAY_APP_PASSWORD: testAppPassword, HOME: home, FRIDAY_HOME: join(home, '.friday'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PORT: String(port) },
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
  assert.equal((await fetch(`${base}/api/system/temperature`)).status, 401);
  assert.equal((await fetch(`${base}/api/socials/gmail/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/socials/calendar/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/socials/slack/status`)).status, 401);
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
  const gmailStatus = await client.request('/api/socials/gmail/status');
  assert.deepEqual(await gmailStatus.json(), { configured: false, connected: false, email: null, scope: null });
  assert.equal((await client.request('/api/socials/calendar/status')).status, 404, 'Google Calendar integration is dormant');
  const slackStatus = await client.request('/api/socials/slack/status');
  assert.deepEqual(await slackStatus.json(), { configured: false, connected: false, workspace: null, selectedChannels: [] });
  assert.equal((await client.request('/api/socials/slack/connect', { method: 'POST' })).status, 503);
  const crossOriginConnect = await client.request('/api/socials/gmail/connect', { method: 'POST', headers: { Origin: 'https://attacker.example' } });
  assert.equal(crossOriginConnect.status, 403);
  const unconfiguredConnect = await client.request('/api/socials/gmail/connect', { method: 'POST' });
  assert.equal(unconfiguredConnect.status, 503);
  const eventPayload = { title: 'Planning', description: 'Sprint review', start: '2026-09-29T14:00:00.000Z', end: '2026-09-29T15:00:00.000Z', timeZone: 'America/New_York' };
  const createdEventResponse = await client.request('/api/calendar/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eventPayload) });
  assert.equal(createdEventResponse.status, 201);
  const { event: createdEvent } = await createdEventResponse.json();
  assert.equal(createdEvent.title, 'Planning');
  const eventsPath = join(home, '.friday', 'data', 'calendar', 'events.json');
  assert.equal((await stat(eventsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, '.friday', 'data', 'calendar'))).mode & 0o777, 0o700);
  assert.equal((await (await client.request('/api/calendar/events')).json()).events.length, 1);
  const updatedResponse = await client.request(`/api/calendar/events/${createdEvent.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...eventPayload, title: 'Review' }) });
  assert.equal((await updatedResponse.json()).event.title, 'Review');
  assert.equal((await client.request(`/api/calendar/events/${createdEvent.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await client.request('/api/calendar/events')).json()).events.length, 0);
  assert.equal(await readFile(legacyCalendarToken, 'utf8'), existingCalendarToken, 'existing Google Calendar credentials are left untouched');
  const temperatureResponse = await client.request('/api/system/temperature');
  assert.equal(temperatureResponse.status, 200);
  const temperature = await temperatureResponse.json();
  assert.ok(['available', 'unsupported', 'unavailable', 'permission-denied'].includes(temperature.status));
  assert.ok(temperature.sampledAt);
  assert.equal(Object.hasOwn(temperature, 'path'), false);
  const appScript = await client.request('/app.js');
  assert.equal(appScript.status, 200);
  assert.match(await appScript.text(), /location\.replace\('\/login\?notice=login-required'\)/);
  for (const [path, marker] of [
    ['/socials.js', 'gmail-connect'],
    ['/local-calendar.js', "from './calendar-view.js'"],
    ['/calendar-view.js', 'buildMonthDays'],
  ]) {
    const asset = await client.request(path);
    assert.equal(asset.status, 200, `${path} must be served for the calendar and socials modules`);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.ok((await asset.text()).includes(marker), `${path} should return its JavaScript module`);
  }

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
