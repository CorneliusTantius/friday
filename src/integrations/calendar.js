import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TTL = 10 * 60_000;
const MAX_EVENTS = 50;

function error(message, status = 400) { const value = new Error(message); value.status = status; return value; }
function safeEvent(event) {
  return {
    summary: typeof event.summary === 'string' ? event.summary.slice(0, 500) : '',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
  };
}

export function createCalendarIntegration({ file, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  if (!file) throw new TypeError('Calendar token file path is required');
  const pending = new Map();
  function configuration() {
    const clientId = env.FRIDAY_CALENDAR_CLIENT_ID;
    const clientSecret = env.FRIDAY_CALENDAR_CLIENT_SECRET;
    const redirectUri = env.FRIDAY_CALENDAR_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return null;
    let callback;
    try { callback = new URL(redirectUri); } catch { return null; }
    if (!['https:', 'http:'].includes(callback.protocol) || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/api/socials/calendar/callback') return null;
    if (callback.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)) return null;
    return { clientId, clientSecret, redirectUri: callback.href };
  }
  async function readTokens() {
    let handle;
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024 || (info.mode & 0o077)) throw new Error('Calendar token store is not a safe private file');
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const value = JSON.parse(await handle.readFile('utf8'));
      return value?.version === 1 && typeof value.refreshToken === 'string' && value.refreshToken ? value : null;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; } finally { await handle?.close(); }
  }
  async function writeTokens(tokens) {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
    const temp = join(dir, `.calendar-auth-${randomUUID()}.tmp`);
    try { await writeFile(temp, `${JSON.stringify(tokens)}\n`, { mode: 0o600, flag: 'wx' }); await chmod(temp, 0o600); await rename(temp, file); await chmod(file, 0o600); }
    finally { await unlink(temp).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function removeTokens() {
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Calendar token store is not a regular file'); await unlink(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async function exchange(params) {
    const response = await fetchImpl(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') throw error('Google authorization failed. Check OAuth configuration and consent.', 502);
    return body;
  }
  async function status() { const tokens = await readTokens(); return { configured: Boolean(configuration()), connected: Boolean(tokens), email: tokens?.email || null, scope: tokens?.scope || null }; }
  async function begin() {
    const config = configuration(); if (!config) throw error('Calendar OAuth is not configured on the Friday host', 503);
    const time = now(); for (const [key, item] of pending) if (item.expiresAt <= time) pending.delete(key);
    if (pending.size >= 32) throw error('Too many Calendar authorization attempts are pending', 429);
    const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
    pending.set(state, { verifier, expiresAt: time + TTL });
    const url = new URL(AUTH); url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { authorizationUrl: url.href };
  }
  function matchingState(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
  function cancel({ state, browserState }) { if (matchingState(state, browserState)) pending.delete(state); }
  async function complete({ code, state, browserState }) {
    const config = configuration(); const item = pending.get(state);
    if (!config || !matchingState(state, browserState) || typeof code !== 'string' || code.length > 4096 || !item || item.expiresAt <= now()) throw error('Calendar authorization expired or was not started by this Friday session');
    pending.delete(state); const previous = await readTokens();
    const token = await exchange({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: item.verifier });
    if (typeof token.scope !== 'string') throw error('Google did not report the granted Calendar permissions.', 502);
    const scopes = token.scope.split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== SCOPE) throw error('Google granted unexpected Calendar permissions; disconnect and review consent.', 502);
    const refreshToken = token.refresh_token || previous?.refreshToken;
    if (!refreshToken) throw error('Google did not return a refresh token. Disconnect Calendar access and connect again.', 502);
    await writeTokens({ version: 1, scope: token.scope || SCOPE, refreshToken, accessToken: token.access_token, expiresAt: now() + Math.max(0, Number(token.expires_in) || 3600) * 1000 });
    return { connected: true };
  }
  async function fresh(tokens) {
    if (typeof tokens.accessToken === 'string' && tokens.expiresAt > now() + 60_000) return tokens;
    const config = configuration(); if (!config) throw error('Calendar OAuth is not configured on the Friday host', 503);
    const value = await exchange({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: tokens.refreshToken, grant_type: 'refresh_token' });
    const updated = { ...tokens, accessToken: value.access_token, expiresAt: now() + Math.max(0, Number(value.expires_in) || 3600) * 1000 }; await writeTokens(updated); return updated;
  }
  async function calendarFetch(url, tokens) {
    let current = await fresh(tokens);
    const request = (item) => fetchImpl(url, { headers: { Authorization: `Bearer ${item.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    let response = await request(current);
    if (response.status === 401) { current = await fresh({ ...current, expiresAt: 0 }); response = await request(current); }
    return { response, tokens: current };
  }
  async function listEvents({ timeMin, timeMax } = {}) {
    let tokens = await readTokens(); if (!tokens) throw error('Connect a Google Calendar first', 409);
    const start = timeMin === undefined ? now() : Date.parse(timeMin);
    const end = timeMax === undefined ? start + 30 * 86400_000 : Date.parse(timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 90 * 86400_000) throw error('Invalid Calendar time range');
    const url = new URL(API); url.search = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), maxResults: String(MAX_EVENTS), singleEvents: 'true', orderBy: 'startTime' }).toString();
    const result = await calendarFetch(url.href, tokens); tokens = result.tokens;
    if (!result.response.ok) {
      const failure = error(result.response.status === 401 ? 'Calendar access expired. Reconnect the account.' : [403, 429].includes(result.response.status) ? 'Google Calendar quota or access limit reached.' : 'Could not load Calendar events.', result.response.status === 401 ? 401 : result.response.status === 429 ? 429 : 502);
      if (result.response.status === 429) {
        failure.retryable = true;
        const retryAfter = Number(result.response.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter >= 0) failure.retryAfter = Math.min(retryAfter, 3600);
      }
      throw failure;
    }
    const data = await result.response.json().catch(() => ({}));
    return { events: (Array.isArray(data.items) ? data.items : []).slice(0, MAX_EVENTS).map(safeEvent) };
  }
  async function disconnect() {
    const tokens = await readTokens(); if (!tokens) return { disconnected: true };
    try { await fetchImpl(REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refreshToken }), signal: AbortSignal.timeout(10_000) }); } catch { /* Local removal is authoritative. */ }
    await removeTokens(); return { disconnected: true };
  }
  return { status, begin, complete, cancel, listEvents, disconnect };
}
