import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayCalendarTools } from '../src/friday/friday-calendar-tools.js';

test('Friday exposes only its bounded read-only Calendar tool', async () => {
  const reads = [];
  const tools = createFridayCalendarTools({
    calendar: { listEvents: async (range) => { reads.push(range); return { events: [] }; } },
    onSensitiveRead: () => reads.push('sensitive'),
  });
  assert.deepEqual(tools.map(({ name }) => name), ['calendar_list_events']);
  const result = await tools[0].execute('1', { timeMin: '2025-01-01T00:00:00Z', timeMax: '2025-01-02T00:00:00Z' });
  assert.deepEqual(result, { content: [{ type: 'text', text: '{"events":[]}' }] });
  assert.equal(reads[0], 'sensitive');
  assert.deepEqual(reads[1], { timeMin: '2025-01-01T00:00:00Z', timeMax: '2025-01-02T00:00:00Z' });
});

test('Friday has no Calendar tool when no Calendar is supplied', () => {
  assert.deepEqual(createFridayCalendarTools(), []);
});
