import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridaySocialTools } from '../src/friday/friday-social-tools.js';

test('Friday social tools expose bounded read-only Calendar and selected-channel Slack reads', async () => {
  const reads = [];
  const tools = createFridaySocialTools({
    calendar: { listEvents: async (range) => { reads.push(['calendar', range]); return { events: [] }; } },
    slack: {
      listSelectedChannels: async () => [{ id: 'C1', name: 'general' }],
      readChannel: async (id, options) => { reads.push(['history', id, options]); return { messages: [] }; },
      readThread: async (id, ts, options) => { reads.push(['thread', id, ts, options]); return { messages: [] }; },
    },
    onSensitiveRead: () => reads.push(['sensitive']),
  });
  assert.deepEqual(tools.map(({ name }) => name), [
    'calendar_list_events', 'slack_list_selected_channels', 'slack_read_channel', 'slack_read_thread',
  ]);
  assert.ok(tools.every(({ name }) => !/write|post|send|search|dm/i.test(name)));
  await tools[0].execute('1', { timeMin: '2025-01-01T00:00:00Z', timeMax: '2025-01-02T00:00:00Z' });
  await tools[2].execute('2', { channelId: 'C1', limit: 50 });
  await tools[3].execute('3', { channelId: 'C1', threadTs: '1.2', limit: 20 });
  assert.equal(reads.filter(([kind]) => kind === 'sensitive').length, 3);
  assert.deepEqual(reads.filter(([kind]) => kind === 'calendar')[0][1], { timeMin: '2025-01-01T00:00:00Z', timeMax: '2025-01-02T00:00:00Z' });
});
