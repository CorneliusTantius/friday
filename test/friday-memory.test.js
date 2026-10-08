import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFridayMemory } from '../src/friday/friday-memory.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'friday-memory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, memory: createFridayMemory({ directory }) };
}

test('appends clearly marked exchanges and lists/reads daily notes', async (t) => {
  const { memory } = await fixture(t);
  await memory.appendDailyLog({ date: '2025-02-03', timestamp: '2025-02-03T12:30:00Z', conversationId: 'conv-1', userMessage: 'Hello', fridayReply: 'Hi there' });
  const content = await memory.readDailyLog('2025-02-03');
  assert.match(content, /^# 2025-02-03\n/);
  assert.match(content, /## Needs review/);
  assert.match(content, /2025-02-03T12:30:00Z/);
  assert.match(content, /Conversation ID: conv-1/);
  assert.match(content, /### User prompt\n\nHello/);
  assert.match(content, /### Friday reply\n\nHi there/);
  assert.deepEqual(await memory.listDailyLogs(), ['2025-02-03']);
  assert.equal(await memory.readDailyLog('2025-02-04'), null);
});

test('rejects invalid dates and unsafe conversation ids', async (t) => {
  const { memory } = await fixture(t);
  await assert.rejects(memory.readDailyLog('../MEMORY'), /date/);
  await assert.rejects(memory.appendDailyLog({ date: '2025-02-30' }), /date/);
  await assert.rejects(memory.appendDailyLog({ date: '2025-01-01', timestamp: 'now', conversationId: '../x', userMessage: '', fridayReply: '' }), /conversationId/);
  assert.deepEqual(await memory.listDailyLogs(), []);
});

test('rejects symlink targets and symlinked directories where supported', async (t) => {
  const { directory, memory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.writeFile(outside, 'do not change');
  try {
    await fs.symlink(outside, path.join(directory, 'MEMORY.md'));
    await assert.rejects(memory.readMemory());
    await assert.rejects(memory.writeMemory('unsafe'));
    await fs.unlink(path.join(directory, 'MEMORY.md'));
    await fs.mkdir(path.join(directory, 'daily'));
    await fs.symlink(outside, path.join(directory, 'daily', '2025-01-01.md'));
    await assert.rejects(memory.readDailyLog('2025-01-01'));
    await assert.rejects(memory.appendDailyLog({ date: '2025-01-01', timestamp: 'now', conversationId: 'c1', userMessage: '', fridayReply: '' }));
    await fs.unlink(path.join(directory, 'daily', '2025-01-01.md'));
    await fs.rm(path.join(directory, 'daily'), { recursive: true });
    await fs.symlink(outside, path.join(directory, 'daily'));
    await assert.rejects(memory.listDailyLogs());
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) return;
    throw error;
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not change');
});

test('builds a safe Obsidian-style graph from explicit wiki links', async (t) => {
  const { memory } = await fixture(t);
  await memory.appendDailyLog({ date: '2025-01-01', timestamp: 'now', conversationId: 'c1', userMessage: 'Hello', fridayReply: 'Hi [[2025-01-02]]' });
  await memory.appendDailyLog({ date: '2025-01-02', timestamp: 'now', conversationId: 'c1', userMessage: 'Second', fridayReply: 'See [[MEMORY]]' });
  await memory.writeMemory('# Curated\nRelated: [[daily/2025-01-01]]');
  const graph = await memory.graph();
  assert.deepEqual(graph.nodes.map(({ id }) => id), ['MEMORY.md', 'daily/2025-01-01.md', 'daily/2025-01-02.md']);
  assert.deepEqual(graph.edges, [
    { source: 'MEMORY.md', target: 'daily/2025-01-01.md' },
    { source: 'daily/2025-01-01.md', target: 'daily/2025-01-02.md' },
    { source: 'daily/2025-01-02.md', target: 'MEMORY.md' },
  ]);
  assert.equal(graph.totalDailyNotes, 2);
  assert.equal(JSON.stringify(graph).includes('Hello'), false, 'graph endpoint exposes metadata and links, not note contents');
});

test('writes private directories and files and supports curated memory', async (t) => {
  const { directory, memory } = await fixture(t);
  await memory.appendDailyLog({ date: '2025-01-01', timestamp: 'now', conversationId: 'c1', userMessage: 'a', fridayReply: 'b' });
  await memory.writeMemory('# Curated\n');
  assert.equal(await memory.readMemory(), '# Curated\n');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(directory, 'daily'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(directory, 'daily', '2025-01-01.md'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(directory, 'MEMORY.md'))).mode & 0o777, 0o600);
  }
});
