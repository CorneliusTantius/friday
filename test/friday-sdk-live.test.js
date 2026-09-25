import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('opt-in Friday SDK starts without installed coding Pi and keeps its own data', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-sdk-live-'));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [new URL('../src/server.js', import.meta.url).pathname], {
    cwd: home,
    env: { ...process.env, FRIDAY_HOME: join(home, '.friday'), PI_COMMAND: join(home, 'missing-pi'),
      FRIDAY_CHAT_DRIVER: 'sdk', PORT: String(port) }, stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(2000)]);
    await rm(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 70; i += 1) {
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready);
  const friday = await fetch(`${base}/api/friday/status`);
  assert.equal(friday.status, 200);
  assert.match((await friday.json()).sessionPath, /\.friday\/data\/.*\.jsonl$/);
  assert.equal((await fetch(`${base}/api/pi/settings`)).status, 404);
});
