import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SCOPES = 'channels:read channels:history';
const CALLBACK = '/api/socials/slack/callback';
const API = 'https://slack.com/api/';
const MAX_MESSAGES = 30;
const MAX_TEXT = 2000;
const MAX_THREAD_MESSAGES = 20;

function sameState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function safeError(message, status = 502, retryable = false) {
  const error = new Error(message);
  error.status = status;
  error.retryable = retryable;
  return error;
}

export function createSlackIntegration({ file, selectionFile, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  if (!file || !selectionFile) throw new TypeError('Slack token and selected-channel file paths are required');
  const pending = new Map();
  const config = () => {
    const clientId = env.FRIDAY_SLACK_CLIENT_ID;
    const clientSecret = env.FRIDAY_SLACK_CLIENT_SECRET;
    const redirectUri = env.FRIDAY_SLACK_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return null;
    let url;
    try { url = new URL(redirectUri); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== CALLBACK || url.search || url.hash || url.username || url.password) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return { clientId, clientSecret, redirectUri: url.href };
  };
  async function put(path, value) {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const temp = join(dir, `.slack-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
      await chmod(temp, 0o600); await rename(temp, path); await chmod(path, 0o600);
    } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function get(path) {
    let handle;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o077)) throw new Error('Slack private store is unsafe');
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      return JSON.parse(await handle.readFile('utf8'));
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    finally { await handle?.close(); }
  }
  async function remove(path) { await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw safeError('Slack request failed or timed out', 502, true); }
    if (response.status === 429) {
      const retry = Number(response.headers?.get?.('retry-after'));
      const error = safeError('Slack rate limit reached', 429, true);
      if (Number.isFinite(retry) && retry >= 0) error.retryAfter = Math.min(retry, 3600);
      throw error;
    }
    let body;
    try { body = await response.json(); } catch { throw safeError('Invalid Slack response'); }
    if (!response.ok || body?.ok === false) throw safeError('Slack request was rejected', response.status >= 400 ? response.status : 502, response.status >= 500);
    return body;
  }
  async function tokens() { const value = await get(file); return value?.version === 1 && typeof value.botToken === 'string' && value.botToken ? value : null; }
  async function api(method, params = {}) {
    const auth = await tokens();
    if (!auth) throw safeError('Slack is not connected', 401);
    const url = new URL(`${API}${method}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    return request(url, { headers: { authorization: `Bearer ${auth.botToken}` } });
  }
  return {
    async status() {
      const [auth, selected] = await Promise.all([tokens(), get(selectionFile)]);
      return { configured: Boolean(config()), connected: Boolean(auth), workspace: auth?.workspace || null, selectedChannels: Array.isArray(selected?.channels) ? selected.channels : [] };
    },
    async begin() {
      const c = config(); if (!c) throw safeError('Slack OAuth is not configured', 503);
      for (const [key, expiry] of pending) if (expiry <= now()) pending.delete(key);
      if (pending.size >= 32) throw safeError('Too many Slack authorization attempts are pending', 429);
      const state = randomBytes(32).toString('hex'); pending.set(state, now() + 600000);
      const url = new URL('https://slack.com/oauth/v2/authorize');
      url.search = new URLSearchParams({ client_id: c.clientId, scope: SCOPES, redirect_uri: c.redirectUri, state }).toString();
      return { url: url.href, state };
    },
    async complete({ code, state, browserState } = {}) {
      const expiry = pending.get(state);
      if (!expiry || expiry < now() || !sameState(state, browserState) || typeof code !== 'string' || !code || code.length > 4096) throw safeError('Invalid or expired Slack OAuth state', 400);
      pending.delete(state);
      const c = config(); if (!c) throw safeError('Slack OAuth is not configured', 503);
      const result = await request('https://slack.com/api/oauth.v2.access', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: c.redirectUri }), });
      if (!result.access_token || !result.team?.id) throw safeError('Slack authorization response is incomplete');
      const granted = String(result.scope || '').split(',').filter(Boolean).sort();
      if (granted.join(' ') !== 'channels:history channels:read') throw safeError('Slack granted unexpected permissions; review the OAuth app scopes.', 502);
      await put(file, { version: 1, botToken: result.access_token, workspace: { id: result.team.id, name: String(result.team.name || '').slice(0, 200) } });
      return { workspace: { id: result.team.id, name: String(result.team.name || '').slice(0, 200) } };
    },
    async cancel({ state, browserState } = {}) { if (sameState(state, browserState)) pending.delete(state); return { ok: true }; },
    async disconnect() {
      const auth = await tokens();
      if (auth) {
        try { await request('https://slack.com/api/auth.revoke', { method: 'POST', headers: { authorization: `Bearer ${auth.botToken}` } }); } catch { /* Local removal remains authoritative. */ }
      }
      await remove(file); await remove(selectionFile); return { disconnected: true };
    },
    async listChannels() {
      const result = await api('conversations.list', { types: 'public_channel', limit: 200, exclude_archived: true });
      return (result.channels || []).slice(0, 200).map(c => ({ id: String(c.id || '').slice(0, 100), name: String(c.name || '').slice(0, 200), isPrivate: false }));
    },
    async setSelectedChannels(channelIds) {
      if (!Array.isArray(channelIds) || channelIds.length > 100 || channelIds.some(id => typeof id !== 'string' || !/^C[A-Z0-9]+$/.test(id))) throw safeError('Invalid selected channels', 400);
      const unique = [...new Set(channelIds)];
      const allowed = new Set((await this.listChannels()).map(({ id }) => id));
      if (unique.some((id) => !allowed.has(id))) throw safeError('Selected channels must be accessible public channels in the connected workspace', 400);
      await put(selectionFile, { version: 1, channels: unique });
      return { channels: unique };
    },
    async listSelectedChannels() {
      const selected = await get(selectionFile);
      if (!Array.isArray(selected?.channels) || !selected.channels.length) return [];
      const allowed = new Set(selected.channels);
      return (await this.listChannels()).filter(({ id }) => allowed.has(id));
    },
    async readChannel(channelId, { limit = 20, oldest, latest } = {}) {
      const selected = await get(selectionFile);
      if (!Array.isArray(selected?.channels) || !selected.channels.includes(channelId)) throw safeError('Channel is not selected', 403);
      if (!/^C[A-Z0-9]+$/.test(channelId)) throw safeError('Invalid channel', 400);
      limit = Math.max(1, Math.min(MAX_MESSAGES, Math.floor(Number(limit) || 50)));
      const validTimestamp = (value) => typeof value === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(value);
      if ((oldest !== undefined && !validTimestamp(oldest)) || (latest !== undefined && !validTimestamp(latest))) throw safeError('Invalid Slack time range', 400);
      const result = await api('conversations.history', { channel: channelId, limit, oldest, latest });
      const messages = (result.messages || []).slice(0, limit).map(m => ({
        timestamp: typeof m.ts === 'string' ? m.ts.slice(0, 32) : '',
        text: typeof m.text === 'string' ? m.text.replace(/<@[A-Z0-9]+>/g, '[user]').replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1').slice(0, MAX_TEXT) : '',
        thread: { ts: typeof m.thread_ts === 'string' ? m.thread_ts.slice(0, 32) : Number(m.reply_count) > 0 && typeof m.ts === 'string' ? m.ts.slice(0, 32) : null, replies: Math.min(1000, Math.max(0, Number(m.reply_count) || 0)) },
      }));
      return { channel: channelId, messages, hasMore: Boolean(result.has_more) };
    },
    async readThread(channelId, threadTs, { limit = 20 } = {}) {
      const selected = await get(selectionFile);
      if (!Array.isArray(selected?.channels) || !selected.channels.includes(channelId)) throw safeError('Channel is not selected', 403);
      if (!/^C[A-Z0-9]+$/.test(channelId) || typeof threadTs !== 'string' || !/^\d{1,12}(?:\.\d{1,6})?$/.test(threadTs)) throw safeError('Invalid Slack thread', 400);
      limit = Math.max(1, Math.min(MAX_THREAD_MESSAGES, Math.floor(Number(limit) || 20)));
      const result = await api('conversations.replies', { channel: channelId, ts: threadTs, limit });
      const messages = (result.messages || []).slice(0, limit).map(m => ({
        timestamp: typeof m.ts === 'string' ? m.ts.slice(0, 32) : '',
        text: typeof m.text === 'string' ? m.text.replace(/<@[A-Z0-9]+>/g, '[user]').replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1').slice(0, MAX_TEXT) : '',
        threadTs: typeof m.thread_ts === 'string' ? m.thread_ts.slice(0, 32) : null,
      }));
      return { channel: channelId, threadTs, messages, hasMore: Boolean(result.has_more) };
    },
  };
}
