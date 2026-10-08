import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFinanceStore } from '../src/storage/finances.js';

test('finance store persists rupiah and sorts newest entries first', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-finances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'finances.json');
  const store = createFinanceStore({ file });
  await store.add({ type: 'expense', amount: '1230', date: '2026-01-02', category: 'Food', description: 'Lunch' });
  await store.add({ type: 'income', amount: '1000', date: '2026-01-03', category: 'Income', description: 'Pay' });
  const entries = await store.list();
  assert.equal(entries[0].amount, 1000);
  assert.equal(entries[1].amount, 1230);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 2);
  const updated = await store.updateEntry(entries[1].id, { amount: '110050', description: 'Updated pay' });
  assert.equal(updated.amount, 110050);
  assert.equal(updated.description, 'Updated pay');
  const reopened = createFinanceStore({ file });
  assert.equal((await reopened.list()).find((entry) => entry.id === entries[1].id).amount, 110050);
  assert.equal(await reopened.remove('missing'), false);
  assert.equal(await reopened.remove(entries[1].id), true);
});

test('finance store rejects invalid amounts, dates, and categories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-finances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFinanceStore({ file: join(directory, 'finances.json') });
  await assert.rejects(store.add({ type: 'expense', amount: '1.999', date: '2026-01-02', category: 'Food', description: '' }), /amount/);
  await assert.rejects(store.add({ type: 'expense', amount: '1', date: '2026-02-31', category: 'Food', description: '' }), /date/);
  await assert.rejects(store.add({ type: 'expense', amount: '1', date: '2026-01-02', category: 'Invalid', description: '' }), /category/);
});
