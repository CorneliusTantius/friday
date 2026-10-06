import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayChat } from '../public/friday-chat.js';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classNames = new Set();
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.visible = true;
    this.parentElement = null;
    this.storedScrollTop = 0;
    this.classList = {
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classNames.has(name) : force;
        if (enabled) this.classNames.add(name); else this.classNames.delete(name);
        return enabled;
      },
      add: (name) => this.classNames.add(name),
      remove: (name) => this.classNames.delete(name),
    };
  }
  get className() { return [...this.classNames].join(' '); }
  set className(value) { this.classNames = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get options() { return this.children; }
  get isConnected() { return true; }
  get clientHeight() { return this.visible ? 200 : 0; }
  get scrollHeight() { return this.children.length * 120; }
  get scrollTop() { return this.storedScrollTop; }
  set scrollTop(value) { if (this.visible) this.storedScrollTop = value; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  replaceChildren(...items) {
    for (const item of this.children) item.parentElement = null;
    this.children = [];
    this.append(...items);
  }
  append(...items) {
    for (const item of items) {
      item.parentElement = this;
      this.children.push(item);
    }
  }
  appendChild(item) { this.append(item); return item; }
  replaceWith(item) {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    item.parentElement = this.parentElement;
    siblings[index] = item;
    this.parentElement = null;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    this.parentElement = null;
  }
  querySelector(selector) {
    if (selector.startsWith('.')) return this.children.find((child) => child.classNames.has(selector.slice(1))) || null;
    return null;
  }
  getClientRects() { return this.visible ? [{}] : []; }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHistory(count, prefix = 'Message') {
  return Array.from({ length: count }, (_, index) => ({ role: 'user', content: `${prefix} ${index}` }));
}

function treeText(element) {
  return [element.textContent, ...element.children.map(treeText)].join(' ');
}

test('Friday chat scrolls to latest on first visible entry and re-entry, but preserves an upward reading position during updates', async (t) => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 0;
  globalThis.setTimeout = (callback, delay) => { const id = ++nextTimerId; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const ids = [
    'friday-messages', 'friday-form', 'friday-message', 'friday-send', 'friday-model',
    'friday-thinking-level', 'friday-status', 'friday-context-usage', 'friday-context-progress',
    'friday-context-label', 'friday-announcement',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const transcript = elements.get('friday-messages');
  transcript.visible = false;
  const documentListeners = new Map();
  globalThis.document = {
    visibilityState: 'visible',
    querySelector: (selector) => elements.get(selector.slice(1)) || null,
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, listener) => documentListeners.set(type, listener),
  };
  globalThis.window = {};
  globalThis.requestAnimationFrame = (callback) => setImmediate(callback);
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    timers.clear();
  });

  let history = makeHistory(30, 'Cached');
  let fridayBusy = false;
  let historyReads = 0;
  const pendingHistory = [];
  const apiJson = async (path) => {
    if (path === '/api/friday/history') {
      historyReads += 1;
      return pendingHistory.shift()?.promise || { messages: history };
    }
    if (path === '/api/friday/status') return { busy: fridayBusy, canAbort: fridayBusy, contextUsage: null };
    if (path === '/api/friday/models') return { models: [], current: null };
    if (path === '/api/friday/thinking-levels') return { levels: ['off'], current: 'off' };
    throw new Error(`Unexpected API request: ${path}`);
  };
  let piStatusRefreshes = 0;
  let displayedPiStatus = 'stale';
  const chat = createFridayChat({
    apiJson,
    renderMarkdown: (element, text) => { element.textContent = text; },
    toast: () => {},
    onEnter: async () => { piStatusRefreshes += 1; displayedPiStatus = 'Open · idle'; },
  });
  await chat.start();
  assert.equal(transcript.scrollTop, 0, 'hidden initial render cannot establish the visible scroll position');
  assert.match(treeText(transcript), /Cached 29/, 'initial transcript is stale in this regression setup');

  history = [...makeHistory(29, 'Server current'), { role: 'assistant', content: 'Current backend reply' }];
  transcript.visible = true;
  await chat.enterView();
  assert.equal(piStatusRefreshes, 1, 'entering Friday must refresh the supported Pi conversation status as well');
  assert.equal(displayedPiStatus, 'Open · idle', 'the stale Pi status is replaced from the entry refresh');
  assert.equal(historyReads, 2, 'entering an already-started idle session must fetch history again');
  assert.equal(transcript.children.length, history.length, 'entry reconciles stale messages against backend history');
  assert.match(treeText(transcript), /Current backend reply/);
  assert.doesNotMatch(treeText(transcript), /Cached/);
  assert.equal(transcript.scrollTop, transcript.scrollHeight, 'first visible entry should land at the latest backend message');
  assert.equal(timers.size, 1, 'a visible Friday chat schedules status and transcript polling');
  assert.equal([...timers.values()][0].delay, 15_000, 'idle polling uses a sensible slower interval');
  const readsBeforeHidden = historyReads;
  globalThis.document.visibilityState = 'hidden';
  documentListeners.get('visibilitychange')();
  assert.equal(timers.size, 0, 'polling pauses when the browser tab is hidden');
  globalThis.document.visibilityState = 'visible';
  documentListeners.get('visibilitychange')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyReads, readsBeforeHidden + 1, 'returning to a visible tab immediately reconciles history');

  const staleResponse = deferred();
  pendingHistory.push(staleResponse);
  const latestHistory = [...makeHistory(28, 'Backend after overlap'), { role: 'assistant', content: 'Newest backend reply' }];
  const requestsBeforeOverlap = historyReads;
  const entering = chat.enterView();
  const concurrentRefresh = chat.refreshTranscript();
  history = latestHistory;
  staleResponse.resolve({ messages: [...makeHistory(8, 'Old in-flight'), { role: 'assistant', content: 'Old in-flight reply' }] });
  await Promise.all([entering, concurrentRefresh]);
  assert.equal(piStatusRefreshes, 2, 'overlapping view entry still awaits one Pi status refresh');
  assert.equal(historyReads, requestsBeforeOverlap + 2, 'a refresh requested during an in-flight read must run and be awaited');
  assert.equal(transcript.children.length, latestHistory.length);
  assert.match(treeText(transcript), /Newest backend reply/);
  assert.doesNotMatch(treeText(transcript), /Old in-flight/);

  transcript.scrollTop = 120;
  const heldPosition = transcript.scrollTop;
  history = [...latestHistory, { role: 'assistant', content: 'Streaming update' }];
  await chat.refreshTranscript();
  assert.equal(transcript.scrollTop, heldPosition, 'a history update must not pull a reader away from older messages');

  transcript.visible = false;
  transcript.visible = true;
  await chat.enterView();
  assert.equal(transcript.scrollTop, transcript.scrollHeight, 're-entering Friday should scroll to the latest message');

  history = [...history, { role: 'assistant', content: 'Another streamed update' }];
  await chat.refreshTranscript();
  assert.equal(transcript.scrollTop, transcript.scrollHeight, 'readers already at the bottom should follow new messages');

  fridayBusy = true;
  await chat.enterView();
  assert.equal([...timers.values()][0].delay, 2_000, 'busy Friday conversations poll more frequently');
  chat.stop();
});
