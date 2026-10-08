import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const MAX_PAGE_SIZE = 20;

function oauthError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeHeaders(message) {
  const values = Object.fromEntries((message.payload?.headers || [])
    .filter(({ name }) => ['from', 'subject', 'date'].includes(String(name).toLowerCase()))
    .map(({ name, value }) => [String(name).toLowerCase(), value]));
  return {
    id: message.id,
    threadId: message.threadId,
    from: values.from || '',
    subject: values.subject || '(no subject)',
    date: values.date || '',
    unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
  };
}

export function createGmailIntegration({ file, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  if (!file) throw new TypeError('Gmail token file path is required');
  const pendingStates = new Map();

  function configuration() {
    const { FRIDAY_GMAIL_CLIENT_ID: clientId, FRIDAY_GMAIL_CLIENT_SECRET: clientSecret, FRIDAY_GMAIL_REDIRECT_URI: redirectUri } = env;
    if (!clientId || !clientSecret || !redirectUri) return null;
    let callback;
    try { callback = new URL(redirectUri); } catch { return null; }
    if (!['https:', 'http:'].includes(callback.protocol) || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/api/socials/gmail/callback') return null;
    if (callback.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)) return null;
    return { clientId, clientSecret, redirectUri: callback.href };
  }

  async function readTokens() {
    let handle;
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024) throw new Error('Gmail token store is not a safe regular file');
      if (info.mode & 0o077) throw new Error('Gmail token store permissions are too broad');
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const value = JSON.parse(await handle.readFile('utf8'));
      if (value?.version !== 1 || typeof value.refreshToken !== 'string' || !value.refreshToken) return null;
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    } finally { await handle?.close(); }
  }

  async function writeTokens(tokens) {
    const directory = dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await chmod(dirname(directory), 0o700).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const temporary = join(directory, `.gmail-auth-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async function removeTokens() {
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Gmail token store is not a regular file');
      await unlink(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function exchangeToken(params) {
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') throw oauthError('Google authorization failed. Check OAuth configuration and consent.', 502);
    return body;
  }

  async function status() {
    const tokens = await readTokens();
    return {
      configured: Boolean(configuration()),
      connected: Boolean(tokens),
      email: tokens?.email || null,
      scope: tokens?.scope || null,
    };
  }

  async function begin() {
    const config = configuration();
    if (!config) throw oauthError('Gmail OAuth is not configured on the Friday host', 503);
    const nowValue = now();
    for (const [state, item] of pendingStates) if (item.expiresAt <= nowValue) pendingStates.delete(state);
    if (pendingStates.size >= 32) throw oauthError('Too many Gmail authorization attempts are pending', 429);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    pendingStates.set(state, { verifier, expiresAt: nowValue + OAUTH_STATE_TTL_MS });
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.href };
  }

  function matchingState(state, browserState) {
    if (typeof state !== 'string' || typeof browserState !== 'string' || state.length !== browserState.length) return false;
    let difference = 0;
    for (let index = 0; index < state.length; index += 1) difference |= state.charCodeAt(index) ^ browserState.charCodeAt(index);
    return difference === 0;
  }

  function cancel({ state, browserState }) {
    if (matchingState(state, browserState)) pendingStates.delete(state);
  }

  async function complete({ code, state, browserState }) {
    const config = configuration();
    const pending = pendingStates.get(state);
    if (!config || !matchingState(state, browserState) || typeof code !== 'string' || code.length > 4096 || !pending || pending.expiresAt <= now()) {
      throw oauthError('Gmail authorization expired or was not started by this Friday session', 400);
    }
    pendingStates.delete(state);
    const previous = await readTokens();
    const token = await exchangeToken({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: pending.verifier,
    });
    const accessToken = token.access_token;
    const profileResponse = await fetchImpl(`${GMAIL_API}/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || typeof profile.emailAddress !== 'string') throw oauthError('Could not read Gmail account identity', 502);
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : [GMAIL_SCOPE];
    const gmailScopes = scopes.filter((scope) => scope === 'https://mail.google.com/' || scope.includes('googleapis.com/auth/gmail.'));
    if (!scopes.includes(GMAIL_SCOPE) || gmailScopes.some((scope) => scope !== GMAIL_SCOPE)) {
      throw oauthError('Google granted unexpected Gmail permissions; disconnect and review the consent configuration.', 502);
    }
    const refreshToken = token.refresh_token || previous?.refreshToken;
    if (!refreshToken) throw oauthError('Google did not return a refresh token. Disconnect Gmail access in your Google Account and connect again.', 502);
    await writeTokens({
      version: 1,
      email: profile.emailAddress,
      scope: token.scope || GMAIL_SCOPE,
      refreshToken,
      accessToken,
      expiresAt: now() + Math.max(0, Number(token.expires_in) || 3600) * 1000,
    });
    return { email: profile.emailAddress };
  }

  async function freshAccessToken(tokens) {
    if (typeof tokens.accessToken === 'string' && tokens.expiresAt > now() + 60_000) return tokens;
    const config = configuration();
    if (!config) throw oauthError('Gmail OAuth is not configured on the Friday host', 503);
    const refreshed = await exchangeToken({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    });
    const updated = {
      ...tokens,
      accessToken: refreshed.access_token,
      expiresAt: now() + Math.max(0, Number(refreshed.expires_in) || 3600) * 1000,
    };
    await writeTokens(updated);
    return updated;
  }

  async function gmailFetch(url, tokens) {
    const current = await freshAccessToken(tokens);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${current.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      const refreshed = await freshAccessToken({ ...current, expiresAt: 0 });
      const retry = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${refreshed.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      return { response: retry, tokens: refreshed };
    }
    return { response, tokens: current };
  }

  async function listInbox({ pageToken } = {}) {
    let tokens = await readTokens();
    if (!tokens) throw oauthError('Connect a Gmail account first', 409);
    if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 4096)) throw oauthError('Invalid Gmail page token');
    const query = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(MAX_PAGE_SIZE) });
    if (pageToken) query.set('pageToken', pageToken);
    const list = await gmailFetch(`${GMAIL_API}/messages?${query}`, tokens);
    tokens = list.tokens;
    if (!list.response.ok) throw oauthError(list.response.status === 401 ? 'Gmail access expired. Reconnect the account.' : 'Could not load Gmail inbox.', list.response.status === 401 ? 401 : 502);
    const data = await list.response.json().catch(() => ({}));
    const items = await Promise.all((data.messages || []).slice(0, MAX_PAGE_SIZE).map(async ({ id }) => {
      const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
      url.searchParams.set('format', 'metadata');
      for (const header of ['From', 'Subject', 'Date']) url.searchParams.append('metadataHeaders', header);
      const detail = await gmailFetch(url, tokens);
      tokens = detail.tokens;
      if (!detail.response.ok) throw oauthError('Could not load Gmail message metadata.', 502);
      return safeHeaders(await detail.response.json());
    }));
    return { messages: items, nextPageToken: data.nextPageToken || null };
  }

  async function disconnect() {
    const tokens = await readTokens();
    if (!tokens) return { disconnected: true };
    try {
      await fetchImpl(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* Local credential removal must still succeed. */ }
    await removeTokens();
    return { disconnected: true };
  }

  return { status, begin, complete, cancel, listInbox, disconnect };
}
