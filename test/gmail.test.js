import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailIntegration } from '../src/integrations/gmail.js';

const config = {
  FRIDAY_GMAIL_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  FRIDAY_GMAIL_CLIENT_SECRET: 'server-only-secret',
  FRIDAY_GMAIL_REDIRECT_URI: 'https://friday.example.ts.net/api/socials/gmail/callback',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Gmail OAuth uses PKCE and persists only private credentials; inbox returns metadata only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-gmail-'));
  const file = join(dir, 'socials', 'gmail', 'auth.json');
  const requests = [];
  const integration = createGmailIntegration({
    file,
    env: config,
    fetchImpl: async (input, options = {}) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
        const body = new URLSearchParams(options.body);
        if (body.get('grant_type') === 'authorization_code') {
          assert.ok(body.get('code_verifier'));
          return json({ access_token: 'access-token-secret', refresh_token: 'refresh-token-secret', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.metadata' });
        }
      }
      if (url.hostname === 'gmail.googleapis.com' && url.pathname.endsWith('/profile')) return json({ emailAddress: 'owner@example.com' });
      if (url.hostname === 'gmail.googleapis.com' && url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'message-1', threadId: 'thread-1' }], nextPageToken: 'next-token' });
      if (url.hostname === 'gmail.googleapis.com' && url.pathname.endsWith('/messages/message-1')) {
        return json({
          id: 'message-1', threadId: 'thread-1', snippet: 'A safe preview', labelIds: ['INBOX', 'UNREAD'],
          payload: { headers: [{ name: 'From', value: 'Sender <sender@example.com>' }, { name: 'Subject', value: 'Hello' }, { name: 'Date', value: 'Mon, 1 Jan 2024 12:00:00 +0000' }], body: { data: 'private body must not escape metadata response' } },
        });
      }
      if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') return new Response(null, { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.deepEqual(await integration.status(), { configured: true, connected: false, email: null, scope: null });
  const { authorizationUrl } = await integration.begin();
  const authorization = new URL(authorizationUrl);
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.metadata');
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const state = authorization.searchParams.get('state');
  assert.ok(authorization.searchParams.get('code_challenge'));
  await assert.rejects(integration.complete({ code: 'authorization-code', state, browserState: 'attacker-state' }), /expired or was not started/);
  assert.deepEqual(await integration.complete({ code: 'authorization-code', state, browserState: state }), { email: 'owner@example.com' });

  const permissions = (await stat(file)).mode & 0o777;
  assert.equal(permissions, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.email, 'owner@example.com');
  assert.equal(saved.refreshToken, 'refresh-token-secret');
  assert.doesNotMatch(JSON.stringify(saved), /private body/);
  assert.deepEqual(await integration.status(), { configured: true, connected: true, email: 'owner@example.com', scope: 'https://www.googleapis.com/auth/gmail.metadata' });

  const inbox = await integration.listInbox();
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].from, 'Sender <sender@example.com>');
  assert.equal(inbox.messages[0].subject, 'Hello');
  assert.equal(inbox.messages[0].unread, true);
  assert.equal(Object.hasOwn(inbox.messages[0], 'snippet'), false);
  assert.equal(Object.hasOwn(inbox.messages[0], 'body'), false);
  assert.equal(inbox.nextPageToken, 'next-token');
  const listing = requests.find(({ url }) => url.pathname.endsWith('/messages'));
  assert.equal(listing.url.searchParams.get('labelIds'), 'INBOX');
  assert.equal(listing.url.searchParams.get('maxResults'), '20');
  assert.equal(listing.url.searchParams.has('q'), false);
  const detail = requests.find(({ url }) => url.pathname.endsWith('/messages/message-1'));
  assert.equal(detail.url.searchParams.get('format'), 'metadata');
  assert.deepEqual(detail.url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date']);

  assert.deepEqual(await integration.disconnect(), { disconnected: true });
  assert.equal(await integration.status().then((value) => value.connected), false);
  assert.equal(requests.some(({ url }) => url.pathname === '/revoke'), true);
});

test('Gmail OAuth rejects unstarted and expired state and invalid public HTTP redirects', async () => {
  let requests = 0;
  const dir = await mkdtemp(join(tmpdir(), 'friday-gmail-invalid-'));
  const integration = createGmailIntegration({ file: join(dir, 'auth.json'), env: config, fetchImpl: async () => { requests += 1; return json({}); } });
  await assert.rejects(integration.complete({ code: 'x', state: 'forged' }), /expired or was not started/);
  const { authorizationUrl } = await integration.begin();
  const state = new URL(authorizationUrl).searchParams.get('state');
  integration.cancel({ state, browserState: state });
  await assert.rejects(integration.complete({ code: 'x', state, browserState: state }), /expired or was not started/);
  assert.equal(requests, 0);
  const insecure = createGmailIntegration({ file: join(dir, 'other.json'), env: { ...config, FRIDAY_GMAIL_REDIRECT_URI: 'http://0.0.0.0/callback' } });
  assert.equal((await insecure.status()).configured, false);
  await assert.rejects(insecure.begin(), /not configured/);
  await rm(dir, { recursive: true, force: true });
});
