import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../public/socials.js', import.meta.url), 'utf8');

class Element {
  constructor(id) {
    this.id = id;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  querySelectorAll() { return []; }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createPage(fetchImpl, { activeFeature = '' } = {}) {
  const elements = new Map();
  const selectors = [
    '#gmail-status', '#gmail-inbox-status', '#gmail-connect', '#gmail-refresh', '#gmail-disconnect', '#gmail-message-list', '#gmail-next-page',
    '#slack-status', '#slack-channels-status', '#slack-connect', '#slack-refresh-channels', '#slack-disconnect', '#slack-save-channels', '#slack-channel-list',
    '[data-feature][aria-current="page"]',
  ];
  for (const selector of selectors) elements.set(selector, new Element(selector));
  elements.get('[data-feature][aria-current="page"]').dataset.feature = activeFeature;
  const documentListeners = new Map();
  const assigned = [];
  const calls = [];
  const context = {
    document: {
      body: new Element('body'),
      querySelector: (selector) => elements.get(selector) || new Element(selector),
      addEventListener: (type, listener) => documentListeners.set(type, listener),
    },
    fetch: async (path, options = {}) => { calls.push({ path, options }); return fetchImpl(path, options); },
    location: { href: 'https://friday.test/', assign: (url) => assigned.push(url), replace: (url) => assigned.push(url) },
    history: { replaceState() {} },
    confirm: () => true,
    AbortController,
    URL,
    URLSearchParams,
    setTimeout: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
    clearTimeout,
    console,
  };
  vm.runInNewContext(script, context, { filename: 'socials.js' });
  return { elements, calls, assigned, documentListeners };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 15));
const connectedStatus = { configured: true, connected: false };

test('connected provider statuses replace loading text and hide connect actions', async () => {
  const page = createPage(async (path) => {
    if (path === '/api/socials/gmail/status') return response({ configured: true, connected: true, email: 'user@example.test' });
    if (path === '/api/socials/slack/status') return response({ configured: true, connected: true, workspace: { name: 'Friday workspace' }, selectedChannels: [] });
    return response({});
  });
  await settled();
  assert.equal(page.elements.get('#gmail-status').textContent, 'Connected as user@example.test');
  assert.equal(page.elements.get('#slack-status').textContent, 'Connected to Friday workspace');
  for (const id of ['#gmail-connect', '#slack-connect']) assert.equal(page.elements.get(id).hidden, true);
});

test('provider status errors and fetch timeouts leave statuses actionable and connect controls usable', async () => {
  const page = createPage(async (path, options) => {
    if (path === '/api/socials/gmail/status') return response({ error: 'Gmail status unavailable' }, 503);
    if (path === '/api/socials/slack/status') return {
      ok: true, status: 200,
      json: () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })),
    };
    return response({});
  });
  await settled();
  for (const [key, name] of [['#gmail-status', 'Gmail'], ['#slack-status', 'Slack']]) {
    assert.doesNotMatch(page.elements.get(key).textContent, /Checking connection/);
    assert.match(page.elements.get(key).textContent, /unavailable|timed out|timeout/i, `${name} reports a useful status failure`);
  }
  for (const key of ['#gmail-connect', '#slack-connect']) assert.equal(page.elements.get(key).disabled, false, `${key} remains retryable after status failure`);
});

test('Gmail and Slack connect buttons call their provider-specific routes and validate redirects', async () => {
  const urls = {
    '/api/socials/gmail/connect': 'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail',
    '/api/socials/slack/connect': 'https://slack.com/oauth/v2/authorize?scope=channels',
  };
  const page = createPage(async (path) => {
    if (path.endsWith('/status')) return response(connectedStatus);
    if (urls[path]) return response({ authorizationUrl: urls[path] });
    return response({});
  });
  await settled();
  for (const id of ['#gmail-status', '#slack-status']) assert.equal(page.elements.get(id).textContent, 'Not connected');
  for (const [buttonId, route] of [
    ['#gmail-connect', '/api/socials/gmail/connect'],
    ['#slack-connect', '/api/socials/slack/connect'],
  ]) await page.elements.get(buttonId).listeners.get('click')();
  const starts = page.calls.filter(({ options }) => options.method === 'POST');
  assert.deepEqual(starts.map(({ path }) => path), [
    '/api/socials/gmail/connect', '/api/socials/slack/connect',
  ]);
  assert.deepEqual(page.assigned, Object.values(urls));
  assert.ok(starts.every(({ options }) => options.credentials === 'same-origin'));
  assert.ok(starts.every(({ options }) => options.signal instanceof AbortSignal));
});

test('connect rejects non-provider authorization redirects and restores the button', async () => {
  const page = createPage(async (path) => {
    if (path.endsWith('/status')) return response(connectedStatus);
    if (path === '/api/socials/gmail/connect') return response({ authorizationUrl: 'https://attacker.example/authorize' });
    return response({});
  });
  await settled();
  await page.elements.get('#gmail-connect').listeners.get('click')();
  assert.match(page.elements.get('#gmail-status').textContent, /invalid authorization URL/);
  assert.deepEqual(page.assigned, []);
  assert.equal(page.elements.get('#gmail-connect').disabled, false);
});

test('failed connect starts surface provider errors and restore the button', async () => {
  const page = createPage(async (path, options) => {
    if (path.endsWith('/status')) return response(connectedStatus);
    if (path === '/api/socials/gmail/connect') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    if (path.endsWith('/connect')) return response({ error: 'OAuth is not configured' }, 503);
    return response({});
  });
  await settled();
  for (const [buttonId, statusId, errorText] of [
    ['#gmail-connect', '#gmail-status', /timed out/],
    ['#slack-connect', '#slack-status', /OAuth is not configured/],
  ]) {
    const button = page.elements.get(buttonId);
    await button.listeners.get('click')();
    assert.match(page.elements.get(statusId).textContent, errorText);
    assert.equal(button.disabled, false, `${buttonId} can be retried after failure`);
  }
});

test('stale provider status responses cannot overwrite newer status', async () => {
  let resolveFirst;
  let gmailStatusCount = 0;
  const page = createPage(async (path) => {
    if (path === '/api/socials/gmail/status') {
      gmailStatusCount += 1;
      if (gmailStatusCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return response({ configured: true, connected: false });
    }
    if (path.endsWith('/status')) return response(connectedStatus);
    if (path.endsWith('/disconnect')) return response({ disconnected: true });
    return response({});
  });
  await settled();
  await page.elements.get('#gmail-disconnect').listeners.get('click')();
  assert.equal(page.elements.get('#gmail-status').textContent, 'Not connected');
  resolveFirst(response({ configured: true, connected: true, email: 'stale@example.test' }));
  await settled();
  assert.equal(page.elements.get('#gmail-status').textContent, 'Not connected');
  assert.equal(page.elements.get('#gmail-connect').disabled, false);
});
