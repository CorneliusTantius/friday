import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCalendarIntegration } from '../src/integrations/calendar.js';

const config = { FRIDAY_CALENDAR_CLIENT_ID: 'calendar-client', FRIDAY_CALENDAR_CLIENT_SECRET: 'private-secret', FRIDAY_CALENDAR_REDIRECT_URI: 'https://friday.example/api/socials/calendar/callback' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('Calendar OAuth is PKCE/read-only and event listing minimizes data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-calendar-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'socials', 'calendar', 'auth.json'); const requests = [];
  const integration = createCalendarIntegration({ file, env: config, fetchImpl: async (input, options = {}) => {
    const url = new URL(input); requests.push({ url, options });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const body = new URLSearchParams(options.body);
      if (body.get('grant_type') === 'authorization_code') { assert.ok(body.get('code_verifier')); return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events.readonly' }); }
      return json({ access_token: 'refreshed', expires_in: 3600 });
    }
    if (url.pathname === '/calendar/v3/calendars/primary/events') return json({ items: [{ id: '1', summary: 'Meeting', description: 'Details', start: { dateTime: '2025-01-01T10:00:00Z' }, end: { dateTime: '2025-01-01T11:00:00Z' }, attendees: [{ email: 'private@example.com' }], creator: { email: 'private@example.com' } }] });
    if (url.pathname === '/revoke') return new Response(null, { status: 200 });
    throw new Error(`Unexpected request ${url}`);
  } });
  const { authorizationUrl } = await integration.begin(); const auth = new URL(authorizationUrl);
  assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events.readonly');
  assert.equal(auth.searchParams.get('redirect_uri'), config.FRIDAY_CALENDAR_REDIRECT_URI);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const state = auth.searchParams.get('state');
  await assert.rejects(integration.complete({ code: 'code', state, browserState: 'wrong' }));
  await integration.complete({ code: 'code', state, browserState: state });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).refreshToken, 'refresh');
  const result = await integration.listEvents(); assert.equal(result.events[0].summary, 'Meeting');
  assert.equal(Object.hasOwn(result.events[0], 'attendees'), false);
  assert.equal(Object.hasOwn(result.events[0], 'description'), false);
  assert.equal(Object.hasOwn(result.events[0], 'location'), false);
  assert.equal(Object.hasOwn(result.events[0], 'htmlLink'), false);
  const listing = requests.find(({ url }) => url.pathname.endsWith('/events'));
  assert.equal(listing.url.pathname, '/calendar/v3/calendars/primary/events');
  assert.equal(listing.url.searchParams.get('maxResults'), '50');
  assert.equal(Date.parse(listing.url.searchParams.get('timeMax')) - Date.parse(listing.url.searchParams.get('timeMin')), 30 * 86400_000);
  await assert.rejects(integration.listEvents({ timeMin: '2025-01-01', timeMax: '2026-01-01' }), /Invalid Calendar time range/);
  await integration.disconnect();
});

test('Calendar rejects unexpected scopes and sanitizes quota failures', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'friday-calendar-errors-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json'); let mode = 'scope';
  const integration = createCalendarIntegration({ file, env: config, fetchImpl: async (input) => {
    const url = new URL(input);
    if (url.pathname === '/token') return json({ access_token: 'access', refresh_token: 'refresh', scope: mode === 'scope' ? 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events.readonly' : 'https://www.googleapis.com/auth/calendar.events.readonly' });
    if (url.pathname.endsWith('/events')) return json({ error: 'sensitive details' }, 429);
    return new Response(null, { status: 200 });
  } });
  const { authorizationUrl } = await integration.begin(); const state = new URL(authorizationUrl).searchParams.get('state');
  await assert.rejects(integration.complete({ code: 'code', state, browserState: state }), /unexpected Calendar permissions/);
  mode = 'ok'; const next = await integration.begin(); const nextState = new URL(next.authorizationUrl).searchParams.get('state');
  await integration.complete({ code: 'code', state: nextState, browserState: nextState });
  await assert.rejects(integration.listEvents(), (e) => e.status === 429 && !e.message.includes('sensitive'));
});
