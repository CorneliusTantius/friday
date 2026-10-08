import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackIntegration } from '../src/integrations/slack.js';

async function fixture(fetchImpl) {
  const dir = await mkdtemp(join(tmpdir(), 'slack-test-'));
  return { dir, slack: createSlackIntegration({ file: join(dir, 'token.json'), selectionFile: join(dir, 'selected.json'), env: { FRIDAY_SLACK_CLIENT_ID: 'id', FRIDAY_SLACK_CLIENT_SECRET: 'secret', FRIDAY_SLACK_REDIRECT_URI: 'https://example.test/api/socials/slack/callback' }, fetchImpl }) };
}
const response = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] || null }, json: async () => body });

test('OAuth state, exact callback and scopes; credentials and selections are private', async () => {
  const calls = [];
  const f = await fixture(async (url, options) => {
    calls.push([String(url), options]);
    if (String(url).includes('conversations.list')) return response({ ok: true, channels: [{ id: 'C123', name: 'general' }] });
    return response({ ok: true, access_token: 'xoxb-secret', scope: 'channels:history,channels:read', team: { id: 'T1', name: 'Example' } });
  });
  try {
    const { url, state } = await f.slack.begin();
    const auth = new URL(url);
    assert.equal(auth.searchParams.get('scope'), 'channels:read channels:history');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://example.test/api/socials/slack/callback');
    await assert.rejects(f.slack.complete({ code: 'code', state: 'bad', browserState: 'bad' }), /state/i);
    await assert.rejects(f.slack.complete({ code: 'code', state, browserState: 'wrong-browser-state' }), /state/i);
    await f.slack.complete({ code: 'code', state, browserState: state });
    await f.slack.setSelectedChannels(['C123']);
    assert.equal((await stat(join(f.dir, 'token.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.dir, 'selected.json'))).mode & 0o777, 0o600);
    assert.equal((await f.slack.status()).workspace.id, 'T1');
    assert.equal(calls[0][0], 'https://slack.com/api/oauth.v2.access');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('OAuth rejects Slack grants outside the requested read-only scopes', async (t) => {
  const f = await fixture(async () => response({ ok: true, access_token: 'xoxb-secret', scope: 'channels:history,channels:read,chat:write', team: { id: 'T1', name: 'Example' } }));
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const { state } = await f.slack.begin();
  await assert.rejects(f.slack.complete({ code: 'code', state, browserState: state }), /unexpected permissions/i);
  assert.equal((await f.slack.status()).connected, false);
});

test('selected-channel gate and history are bounded and sanitized; never calls DM/write endpoints', async () => {
  const calls = [];
  const f = await fixture(async (url, options) => {
    calls.push([String(url), options]);
    if (String(url).includes('conversations.history')) return response({ ok: true, has_more: true, messages: [{ user: 'U1', ts: '1.2', text: '<@U2> secret '.repeat(500), permalink: 'https://slack.test/message', reply_count: 99999 }] });
    if (String(url).includes('conversations.replies')) return response({ ok: true, messages: [{ user: 'U1', ts: '1.2', text: 'reply' }] });
    if (String(url).includes('conversations.list')) return response({ ok: true, channels: [{ id: 'C123', name: 'general', is_private: false }] });
    return response({ ok: true });
  });
  try {
    await writeFile(join(f.dir, 'token.json'), JSON.stringify({ version: 1, botToken: 'test', workspace: { id: 'T1' } }), { mode: 0o600 });
    await f.slack.setSelectedChannels(['C123']);
    await assert.rejects(f.slack.readChannel('C999'), /not selected/);
    const result = await f.slack.readChannel('C123', { limit: 999 });
    assert.equal(result.messages.length, 1);
    assert.ok(result.messages[0].text.length <= 2000);
    assert.ok(result.messages[0].text.startsWith('[user]'));
    assert.equal(result.messages[0].thread.replies, 1000);
    const historyCall = calls.find(([url]) => url.includes('conversations.history'));
    assert.equal(new URL(historyCall[0]).searchParams.get('limit'), '30');
    const thread = await f.slack.readThread('C123', '1.2', { limit: 500 });
    assert.equal(thread.messages[0].text, 'reply');
    assert.equal(new URL(calls.find(([url]) => url.includes('conversations.replies'))[0]).searchParams.get('limit'), '20');
    assert.ok(calls.every(([url]) => !/\/im\.|\/chat\.|\/search\.|\/users\./.test(url)));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('Slack API failures are sanitized and rate limits expose retry-after', async () => {
  let f = await fixture(async () => response({ ok: false, error: 'invalid_auth', access_token: 'secret' }));
  try {
    await writeFile(join(f.dir, 'token.json'), JSON.stringify({ version: 1, botToken: 'test' }), { mode: 0o600 });
    await writeFile(join(f.dir, 'selected.json'), JSON.stringify({ version: 1, channels: ['C123'] }), { mode: 0o600 });
    await assert.rejects(f.slack.readChannel('C123'), e => e.message === 'Slack request was rejected' && !e.message.includes('invalid_auth'));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
  f = await fixture(async () => response({}, 429, { 'retry-after': '12' }));
  try {
    await writeFile(join(f.dir, 'token.json'), JSON.stringify({ version: 1, botToken: 'test' }), { mode: 0o600 });
    await writeFile(join(f.dir, 'selected.json'), JSON.stringify({ version: 1, channels: ['C123'] }), { mode: 0o600 });
    await assert.rejects(f.slack.readChannel('C123'), e => e.status === 429 && e.retryable && e.retryAfter === 12);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
