import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCalendarStore } from '../src/storage/local-calendar.js';

const event = (overrides = {}) => ({
  title: 'Planning', description: 'Sprint review',
  start: '2026-09-29T10:00:00-04:00', end: '2026-09-29T11:00:00-04:00',
  timeZone: 'America/New_York', ...overrides,
});

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'friday-local-calendar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'private', 'calendar', 'events.json') };
}

test('local calendar persists private owner-only data and supports event CRUD', async (t) => {
  const { dir, file } = await setup(t);
  let clock = '2026-09-01T00:00:00.000Z';
  const store = createLocalCalendarStore({ file, now: () => clock });
  const created = await store.create(event());
  assert.equal(created.title, 'Planning');
  assert.equal(created.start, '2026-09-29T14:00:00.000Z');
  assert.equal(created.timeZone, 'America/New_York');
  assert.equal((await stat(dir + '/private')).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).events.length, 1);

  clock = '2026-09-02T00:00:00.000Z';
  const restored = createLocalCalendarStore({ file, now: () => clock });
  const updated = await restored.update(created.id, event({ title: 'Review' }));
  assert.equal(updated.title, 'Review');
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, clock);
  assert.equal((await restored.list()).length, 1);
  assert.equal((await restored.delete(created.id)).title, 'Review');
  assert.deepEqual(await restored.list(), []);
  assert.equal(await restored.delete(created.id), null);
});

test('local calendar validates required values, time zones, bounds, and event order', async (t) => {
  const { file } = await setup(t);
  const store = createLocalCalendarStore({ file });
  for (const invalid of [
    event({ title: '  ' }), event({ title: 'x'.repeat(161) }), event({ description: 'x'.repeat(2001) }),
    event({ start: '2026-09-29T10:00:00' }), event({ start: '2026-02-30T10:00:00Z' }), event({ end: '2026-09-29T09:00:00Z' }),
    event({ timeZone: 'Not/A_Timezone' }), event({ start: 'bad' }), event({ title: 4 }),
  ]) await assert.rejects(store.create(invalid), { status: 400 });
  await assert.rejects(store.update('not-an-id', event()), { status: 400 });
  assert.deepEqual(await store.list(), []);
});

test('unsupported existing event data is preserved rather than overwritten', async (t) => {
  const { file } = await setup(t);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(file, '..'), { recursive: true }));
  const original = '{"version":99,"keep":"this"}\n';
  await writeFile(file, original, { mode: 0o600 });
  const store = createLocalCalendarStore({ file });
  await assert.rejects(store.create(event()), /unsupported format/);
  assert.equal(await readFile(file, 'utf8'), original);
});
