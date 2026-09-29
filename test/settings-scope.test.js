import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppClient } from '../test-support/app-client.js';

const serverPath = new URL('../src/server.js', import.meta.url).pathname;

test('settings routes keep Friday, System, and Pi scopes independent without starting Pi', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-settings-'));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const piCommand = join(home, 'pi');
  const marker = join(home, 'pi-started');
  const fakeBin = join(home, 'bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await mkdir(join(home, 'friday', 'config'), { recursive: true });
  await writeFile(join(home, 'friday', 'config', 'config.json'), JSON.stringify({ workspace: join(home, '.pi') }));
  await mkdir(join(home, 'friday', 'repos', 'legacy-friday', '.git'), { recursive: true });
  await mkdir(join(home, '.pi', 'repos', 'legacy-pi', '.git'), { recursive: true });
  await writeFile(piCommand, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [serverPath], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      FRIDAY_HOME: join(home, 'friday'),
      PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
      PI_COMMAND: piCommand,
      INVOCATION_ID: '',
      PATH: `${fakeBin}${delimiter}${process.env.PATH || ''}`,
      PORT: String(port),
    },
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
  for (let i = 0; i < 50; i += 1) {
    try { if ((await request('/healthz')).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'server should start');
  for (const [url, method] of [
    ['/api/friday/files', 'GET'],
    ['/api/friday/files/content?path=config/auth.json', 'GET'],
    ['/api/friday/files/content?path=config/auth.json', 'PUT'],
    ['/api/pi/files', 'GET'],
    ['/api/pi/files/content?path=agent/auth.json', 'GET'],
    ['/api/pi/files/content?path=agent/auth.json', 'PUT'],
  ]) {
    assert.equal((await request(url, { method })).status, 401, `${method} ${url} requires app login`);
  }
  await client.login();
  const appHtml = await (await request('/')).text();
  assert.doesNotMatch(appHtml, /data-feature="(?:friday-settings|pi-settings)"/);
  assert.match(appHtml, /<details open class="settings-group friday-settings-group">/);
  assert.ok(appHtml.indexOf('data-feature="dashboard"') < appHtml.indexOf('Friday Agent'));
  assert.match(appHtml, /<h2 id="server-settings-heading">Server<\/h2>[\s\S]*<h3 id="connected-devices-heading">Connected devices<\/h3>/);
  assert.match(appHtml, /id="restart-friday"/);
  const appJs = await (await request('/app.js')).text();
  const settingsRenderer = appJs.slice(appJs.indexOf('function renderSettings'), appJs.indexOf('function renderDashboardCard'));
  assert.doesNotMatch(settingsRenderer, /Current session|Pi command|Thinking|\['Model'/);
  assert.deepEqual((await (await request('/api/repos')).json()).repos.map(({ name }) => name), ['legacy-friday']);
  assert.deepEqual((await (await request('/api/pi/repos')).json()).repos.map(({ name }) => name), ['legacy-pi']);
  const restart = await request('/api/system/restart', { method: 'POST' });
  assert.equal(restart.status, 409, 'manual server instances must not terminate without a systemd restart policy');

  const authorized = await request('/api/friday/auth');
  assert.equal(authorized.status, 200);
  assert.deepEqual((await authorized.json()).providers.map((provider) => provider.providerId), ['openai-codex', 'openai']);
  const login = await request('/api/friday/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', type: 'api_key', key: 'friday-server-test-secret' }),
  });
  assert.equal(login.status, 200);
  assert.doesNotMatch(await login.text(), /friday-server-test-secret/);
  const { readFile, stat } = await import('node:fs/promises');
  const fridayAuthFile = join(home, 'friday', 'config', 'auth.json');
  assert.match(await readFile(fridayAuthFile, 'utf8'), /friday-server-test-secret/);
  assert.equal((await stat(fridayAuthFile)).mode & 0o077, 0);
  const fridayFiles = await (await request('/api/friday/files')).json();
  assert.equal(fridayFiles.directory, join(home, 'friday'));
  const fridayConfigFiles = await (await request('/api/friday/files?path=config')).json();
  assert.equal(fridayConfigFiles.entries.find((item) => item.name === 'auth.json').previewable, true);
  assert.equal(fridayConfigFiles.entries.find((item) => item.name === 'auth.json').editable, true);
  await writeFile(join(home, 'friday', 'config', 'settings.json'), '{"theme":"dark"}');
  const authPreview = await (await request('/api/friday/files/content?path=config/auth.json')).json();
  assert.match(authPreview.content, /friday-server-test-secret/);
  const authWrite = await request('/api/friday/files/content?path=config/auth.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: authPreview.content }),
  });
  assert.equal(authWrite.status, 200);
  const settingsPreview = await (await request('/api/friday/files/content?path=config/settings.json')).json();
  assert.equal(settingsPreview.editable, true);
  const settingsWrite = await request('/api/friday/files/content?path=config/settings.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '{"theme":"light"}' }),
  });
  assert.equal(settingsWrite.status, 200);
  assert.equal((await settingsWrite.json()).path, 'config/settings.json');
  const piFiles = await (await request('/api/pi/files')).json();
  assert.equal(piFiles.directory, join(home, '.pi'));
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  await writeFile(join(home, '.pi', 'agent', 'README.md'), '# Pi notes');
  const markdown = await (await request('/api/pi/files/content?path=agent/README.md')).json();
  assert.equal(markdown.editorType, 'markdown');
  const markdownWrite = await request('/api/pi/files/content?path=agent/README.md', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '# Updated notes\n\n**Edited**' }),
  });
  assert.equal(markdownWrite.status, 200);
  assert.equal((await request('/api/files/content?path=.friday/config/auth.json')).status, 404);
  await assert.rejects(readFile(join(home, '.pi', 'agent', 'auth.json')), { code: 'ENOENT' });
  const oauth = await request('/api/friday/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openai-codex', type: 'oauth' }),
  });
  assert.equal(oauth.status, 202);
  const { token } = await oauth.json();
  const flow = await request(`/api/friday/auth/flow?token=${token}`);
  const prompt = await flow.json();
  assert.equal(prompt.type, 'select');
  assert.equal(prompt.requiresResponse, true);
  assert.ok(prompt.options.some((option) => option.label.includes('Device code')));
  const browserMethod = prompt.options.find((option) => option.label.includes('Browser login'));
  const choice = await request('/api/friday/auth/flow', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, response: browserMethod.id }),
  });
  assert.deepEqual(await choice.json(), { ok: true });
  const authUrl = await request(`/api/friday/auth/flow?token=${token}`);
  const authorization = await authUrl.json();
  assert.equal(authorization.type, 'auth_url');
  assert.match(authorization.url, /^https:\/\//);
  const manual = await request(`/api/friday/auth/flow?token=${token}`);
  assert.equal((await manual.json()).type, 'manual_code');
  const cancel = await request(`/api/friday/auth/flow?token=${token}`, {
    method: 'DELETE',
  });
  assert.deepEqual(await cancel.json(), { cancelled: true });
  assert.equal((await request('/api/pi/auth')).status, 200);
  const github = await (await request('/api/system/github')).json();
  assert.equal(typeof github.available, 'boolean');
  assert.equal(typeof github.authenticated, 'boolean');
  const saveSync = async (scope, owner, repo) => request(`/api/${scope}/sync/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner, repo }),
  });
  const fridaySyncStart = await saveSync('friday', 'owner', 'friday-private');
  assert.equal(fridaySyncStart.status, 200);
  assert.equal((await fridaySyncStart.json()).status, 'Syncing…', 'saving a target starts automatic sync');
  assert.equal((await saveSync('pi', 'owner', 'pi-private')).status, 200);
  assert.equal((await (await request('/api/friday/sync/settings')).json()).repo, 'friday-private');
  assert.equal((await (await request('/api/pi/sync/settings')).json()).repo, 'pi-private');
  assert.equal((await stat(join(home, 'friday', 'config', 'github-sync.json'))).mode & 0o077, 0);
  assert.equal((await stat(join(home, '.pi', 'agent', 'friday-sync.json'))).mode & 0o077, 0);
  assert.equal((await saveSync('pi', '../owner', 'invalid')).status, 400);
  for (const path of ['/api/friday/settings', '/api/system/settings']) {
    const response = await request(path);
    assert.equal(response.status, 200, `${path} should be available without Pi`);
    assert.equal(typeof await response.json(), 'object');
  }
  assert.equal(await import('node:fs/promises').then(({ access }) => access(marker).then(() => true, () => false)), false,
    'Friday and System settings must not start Pi');

  const piSettings = await request('/api/pi/settings');
  assert.equal(piSettings.status, 200);
  assert.equal((await piSettings.json()).workspace, join(home, '.pi', 'workspace'));
  assert.equal(await import('node:fs/promises').then(({ access }) => access(marker).then(() => true, () => false)), true,
    'Pi settings may inspect the installed Pi command');
});
