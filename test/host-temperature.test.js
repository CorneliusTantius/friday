import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostTemperatureMonitor } from '../src/host-temperature.js';

async function makeSysfs(t) {
  const root = await mkdtemp(join(tmpdir(), 'friday-temperature-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, path, value) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, value);
}

test('reads Linux hwmon and thermal-zone values and exposes only the highest temperature', async (t) => {
  const sysRoot = await makeSysfs(t);
  await put(sysRoot, 'class/hwmon/hwmon0/name', 'sensitive-hardware-name');
  await put(sysRoot, 'class/hwmon/hwmon0/temp1_input', '42125\n');
  await put(sysRoot, 'class/thermal/thermal_zone0/type', 'sensitive-zone-name');
  await put(sysRoot, 'class/thermal/thermal_zone0/temp', '45750\n');
  const result = await createHostTemperatureMonitor({ sysRoot }).read();
  assert.equal(result.status, 'available');
  assert.equal(result.celsius, 45.8);
  assert.equal(typeof result.sampledAt, 'string');
  assert.deepEqual(Object.keys(result).sort(), ['celsius', 'sampledAt', 'status']);
});

test('reports unsupported hosts and unavailable or invalid sensors', async (t) => {
  const sysRoot = await makeSysfs(t);
  assert.equal((await createHostTemperatureMonitor({ platformName: 'darwin', sysRoot }).read()).status, 'unsupported');
  await put(sysRoot, 'class/hwmon/hwmon0/temp1_input', 'not-a-number');
  await put(sysRoot, 'class/thermal/thermal_zone0/temp', '999999');
  const result = await createHostTemperatureMonitor({ sysRoot }).read();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.celsius, null);
});

test('reports permission-restricted sensors without failing the request', async (t) => {
  const sysRoot = await makeSysfs(t);
  await put(sysRoot, 'class/hwmon/hwmon0/temp1_input', '43000');
  const monitor = createHostTemperatureMonitor({
    sysRoot,
    readFileImpl: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
  });
  const result = await monitor.read();
  assert.equal(result.status, 'permission-denied');
  assert.equal(result.celsius, null);
});

test('caches samples and coalesces concurrent reads', async (t) => {
  const sysRoot = await makeSysfs(t);
  await put(sysRoot, 'class/hwmon/hwmon0/temp1_input', '43000');
  let now = 10;
  let reads = 0;
  const monitor = createHostTemperatureMonitor({
    sysRoot,
    now: () => now,
    readFileImpl: async (...args) => {
      reads += 1;
      return readFile(...args);
    },
  });
  const [first, concurrent] = await Promise.all([monitor.read(), monitor.read()]);
  assert.deepEqual(first, concurrent);
  assert.equal(reads, 1);
  await monitor.read();
  assert.equal(reads, 1);
  now += 30_000;
  await monitor.read();
  assert.equal(reads, 2);
});
