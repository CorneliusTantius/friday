import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayChat } from '../public/friday-chat.js';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.mutationCount = 0;
    this.scrollWriteCount = 0;
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
  set scrollTop(value) { this.scrollWriteCount += 1; if (this.visible) this.storedScrollTop = value; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  focus() { this.focused = true; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  replaceChildren(...items) {
    this.mutationCount += 1;
    for (const item of this.children) item.parentElement = null;
    this.children = [];
    this.append(...items);
  }
  append(...items) {
    for (const item of items) this.insertBefore(item, null);
  }
  appendChild(item) { this.append(item); return item; }
  insertBefore(item, reference) {
    this.mutationCount += 1;
    if (item === reference) return item;
    if (item.parentElement) {
      const oldSiblings = item.parentElement.children;
      const oldIndex = oldSiblings.indexOf(item);
      if (oldIndex >= 0) oldSiblings.splice(oldIndex, 1);
    }
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    item.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, item);
    return item;
  }
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
    this.parentElement.mutationCount += 1;
    this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    this.parentElement = null;
  }
  querySelector(selector) {
    if (!selector.startsWith('.')) return null;
    for (const child of this.children) {
      if (child.classNames.has(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
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
    'friday-messages', 'friday-form', 'friday-message', 'friday-send', 'friday-stop', 'friday-chat-queue', 'friday-model',
    'friday-thinking-level', 'friday-status', 'friday-task-panel', 'friday-task-board', 'friday-context-usage', 'friday-context-progress',
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
  let backendSessionId = 'friday-session-a';
  let fridayBusy = false;
  let historyReads = 0;
  const historyRequests = [];
  let delegatedTask = null;
  let chatJobs = [];
  const queuedPosts = [];
  const cancelledJobs = [];
  let historyOverride = null;
  const pendingHistory = [];
  const historyWire = (items) => {
    let prefix = '';
    return items.map((message, sequence) => {
      const revision = JSON.stringify(message);
      const item = { ...message, id: `${backendSessionId}:${sequence}`, sequence, revision, prefixRevision: prefix };
      prefix += `${item.id}:${revision};`;
      return item;
    });
  };
  const historyResponse = (path) => {
    const params = new URL(path, 'http://friday.test').searchParams;
    const all = historyWire(history);
    const latest = all.at(-1);
    const full = () => ({ messages: all, sessionId: backendSessionId, reset: true, incremental: false, unchanged: false, latestId: latest?.id || null, latestRevision: latest?.revision || null });
    if (params.get('full') === '1' || params.get('sessionId') !== backendSessionId) return full();
    const afterId = params.get('afterId');
    if (!afterId && all.length) return full();
    if (!afterId) return { messages: [], sessionId: backendSessionId, reset: false, incremental: true, unchanged: true, latestId: null, latestRevision: null };
    const index = all.findIndex((item) => item.id === afterId);
    if (index < 0 || all[index].prefixRevision !== params.get('afterPrefix')) return full();
    const changed = all[index].revision !== params.get('afterRevision');
    const messages = all.slice(index + (changed ? 0 : 1));
    return { messages, sessionId: backendSessionId, reset: false, incremental: true, unchanged: messages.length === 0, latestId: latest?.id || null, latestRevision: latest?.revision || null };
  };
  const apiJson = async (path, options = {}) => {
    if (path.startsWith('/api/friday/history')) {
      historyReads += 1;
      historyRequests.push(path);
      if (historyOverride) { const response = historyOverride; historyOverride = null; return response; }
      return pendingHistory.shift()?.promise || historyResponse(path);
    }
    if (path === '/api/friday/status') return { busy: fridayBusy, canAbort: fridayBusy, chatQueue: chatJobs, contextUsage: null, delegatedTask, tasks: delegatedTask ? [delegatedTask] : [] };
    if (path === '/api/friday/chat' && options.method === 'POST') {
      const id = `123e4567-e89b-42d3-a456-42661417400${queuedPosts.length + 1}`;
      queuedPosts.push({ id, message: JSON.parse(options.body).message });
      chatJobs.push({ id, status: 'queued', position: chatJobs.length + 1 });
      return { id, status: 'queued', position: chatJobs.length };
    }
    const cancelMatch = path.match(/^\/api\/friday\/chat\/([0-9a-f-]+)\/cancel$/);
    if (cancelMatch && options.method === 'POST') {
      cancelledJobs.push(cancelMatch[1]);
      chatJobs = chatJobs.filter((job) => job.id !== cancelMatch[1]);
      return { id: cancelMatch[1], cancelled: true };
    }
    if (path === '/api/friday/models') return { models: [], current: null };
    if (path === '/api/friday/thinking-levels') return { levels: ['off'], current: 'off' };
    throw new Error(`Unexpected API request: ${path}`);
  };
  let piStatusRefreshes = 0;
  let displayedPiStatus = 'stale';
  const chat = createFridayChat({
    apiJson,
    renderMarkdown: (element, text) => {
      const rendered = new FakeElement('rendered-markdown');
      rendered.textContent = text;
      element.append(rendered);
    },
    toast: () => {},
    onEnter: async () => { piStatusRefreshes += 1; displayedPiStatus = 'Open · idle'; },
  });
  const pollNow = async () => {
    globalThis.document.visibilityState = 'hidden';
    documentListeners.get('visibilitychange')();
    globalThis.document.visibilityState = 'visible';
    documentListeners.get('visibilitychange')();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  await chat.start();
  assert.equal(transcript.scrollTop, 0, 'hidden initial render cannot establish the visible scroll position');
  assert.match(treeText(transcript), /Cached 29/, 'initial transcript is stale in this regression setup');

  history = [...makeHistory(29, 'Server current'), { role: 'assistant', content: 'Current backend reply' }];
  transcript.visible = true;
  await chat.enterView();
  assert.equal(piStatusRefreshes, 1, 'entering Friday must refresh the supported Pi conversation status as well');
  assert.equal(displayedPiStatus, 'Open · idle', 'the stale Pi status is replaced from the entry refresh');
  assert.equal(historyReads, 2, 'entering an already-started idle session must fetch history again');
  assert.match(historyRequests.at(-1), /sessionId=friday-session-a&afterId=/, 'polls send the current session and latest known message cursor');
  assert.equal(transcript.children.length, history.length, 'entry reconciles stale messages against backend history');
  assert.match(treeText(transcript), /Current backend reply/);
  assert.doesNotMatch(treeText(transcript), /Cached/);
  assert.equal(transcript.scrollTop, transcript.scrollHeight, 'first visible entry should land at the latest backend message');
  assert.equal(timers.size, 1, 'a visible Friday chat schedules status and transcript polling');
  assert.equal([...timers.values()][0].delay, 15_000, 'idle polling uses a sensible slower interval');
  await new Promise((resolve) => setImmediate(resolve));
  const readsBeforeHidden = historyReads;
  const mutationsBeforeIdlePoll = transcript.mutationCount;
  const scrollWritesBeforeIdlePoll = transcript.scrollWriteCount;
  globalThis.document.visibilityState = 'hidden';
  documentListeners.get('visibilitychange')();
  assert.equal(timers.size, 0, 'polling pauses when the browser tab is hidden');
  globalThis.document.visibilityState = 'visible';
  documentListeners.get('visibilitychange')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyReads, readsBeforeHidden + 1, 'returning to a visible tab immediately reconciles history');
  assert.equal(transcript.mutationCount, mutationsBeforeIdlePoll, 'an unchanged cursor response leaves transcript DOM untouched');
  assert.equal(transcript.scrollWriteCount, scrollWritesBeforeIdlePoll, 'an unchanged poll does not adjust transcript scroll');

  const staleResponse = deferred();
  pendingHistory.push(staleResponse);
  const latestHistory = [...makeHistory(28, 'Backend after overlap'), { role: 'assistant', content: 'Newest backend reply' }];
  const requestsBeforeOverlap = historyReads;
  const entering = chat.enterView();
  const concurrentRefresh = chat.refreshTranscript();
  history = latestHistory;
  const staleMessages = historyWire([...makeHistory(8, 'Old in-flight'), { role: 'assistant', content: 'Old in-flight reply' }]);
  staleResponse.resolve({ messages: staleMessages, sessionId: backendSessionId, reset: true, incremental: false });
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
  assert.match(historyRequests.at(-1), /full=1/, 'explicit history refreshes request a full snapshot');
  assert.equal(transcript.scrollTop, heldPosition, 'a history update must not pull a reader away from older messages');

  transcript.visible = false;
  transcript.visible = true;
  await chat.enterView();
  assert.equal(transcript.scrollTop, transcript.scrollHeight, 're-entering Friday should scroll to the latest message');

  history = [...history, { role: 'assistant', content: 'Another streamed update' }];
  await chat.refreshTranscript();
  assert.equal(transcript.scrollTop, transcript.scrollHeight, 'readers already at the bottom should follow new messages');

  const composer = elements.get('friday-message');
  const composerNode = composer;
  composer.value = 'typed while Friday updates';
  composer.selectionStart = 5;
  composer.selectionEnd = 12;
  composer.scrollTop = 16;
  history = [...history, { role: 'assistant', content: 'Polling update while typing' }];
  await pollNow();
  assert.strictEqual(elements.get('friday-message'), composerNode, 'transcript polling never replaces the composer DOM node');
  assert.equal(composer.value, 'typed while Friday updates');
  assert.deepEqual([composer.selectionStart, composer.selectionEnd, composer.scrollTop], [5, 12, 16], 'polling preserves the typed value, selection, and textarea scroll');
  const partialArticle = transcript.children.at(-1);
  const transcriptCountBeforePartial = transcript.children.length;
  history = [...history.slice(0, -1), { ...history.at(-1), content: 'Polling update while typing — partial' }];
  await pollNow();
  assert.strictEqual(transcript.children.at(-1), partialArticle, 'a partial assistant update patches its existing message node');
  assert.equal(transcript.children.length, transcriptCountBeforePartial, 'partial output updates do not duplicate transcript messages');
  assert.match(treeText(partialArticle), /partial/);
  assert.equal(partialArticle.querySelector('.message-content').children.length, 1, 'partial markdown replaces stale rendered nodes instead of accumulating duplicates');
  assert.deepEqual([composer.value, composer.selectionStart, composer.selectionEnd, composer.scrollTop], ['typed while Friday updates', 5, 12, 16]);

  const calls = [
    { id: 'call-1', name: 'read_file', arguments: { path: 'a.js' } },
    { id: 'call-2', name: 'list_files', arguments: { path: '.' } },
  ];
  history = [{ role: 'assistant', toolCalls: calls }];
  await chat.refreshTranscript();
  const toolGroup = transcript.children[0];
  assert.equal(toolGroup.className, 'tool-group');
  assert.equal(toolGroup.toolList.children.length, 2, 'parallel tool calls each get a collapsible result item');
  assert.match(treeText(toolGroup), /read_file · running/);
  assert.match(treeText(toolGroup), /list_files · running/);
  toolGroup.open = true;
  toolGroup.toolList.children[0].open = true;
  history = [
    { role: 'assistant', toolCalls: calls },
    { role: 'tool', toolCallId: 'call-1', toolName: 'read_file', content: 'const safe = true;' },
    { role: 'tool', toolCallId: 'call-2', toolName: 'list_files', content: 'a.js' },
  ];
  await chat.refreshTranscript();
  assert.strictEqual(transcript.children[0], toolGroup, 'results update the existing accessible tool group');
  assert.strictEqual(toolGroup.toolList.children[0], toolGroup.toolEntries.get('call-1'));
  assert.equal(toolGroup.open, true, 'the group disclosure state survives polling');
  assert.equal(toolGroup.toolList.children[0].open, true, 'each call disclosure state survives polling');
  assert.match(treeText(toolGroup), /Result\nconst safe = true;/);
  assert.match(treeText(toolGroup), /Result\na.js/);

  const statusCall = { id: 'pi-status-1', name: 'pi_sessions', arguments: { action: 'status', runId: 'run-1' } };
  const readCall = { id: 'pi-read-1', name: 'pi_sessions', arguments: { action: 'read', runId: 'run-1' } };
  history = [
    { role: 'assistant', id: 'pi-step-1', toolCalls: [statusCall] },
    { role: 'tool', toolCallId: statusCall.id, toolName: statusCall.name, content: 'Run is idle.' },
    { role: 'assistant', id: 'pi-step-2', toolCalls: [readCall] },
    { role: 'tool', toolCallId: readCall.id, toolName: readCall.name, content: 'Recent conversation excerpt.' },
    { role: 'assistant', id: 'pi-step-3', content: 'Pi conversation inspected.' },
  ];
  await chat.refreshTranscript();
  assert.equal(transcript.children.length, 2, 'sequential Pi inspection calls share one group before Friday’s response');
  const piInspectionGroup = transcript.children[0];
  assert.equal(piInspectionGroup.toolList.children.length, 2);
  assert.match(treeText(piInspectionGroup), /pi_sessions · complete/);
  assert.equal(piInspectionGroup.toolEntries.size, 2, 'list/status/read actions remain separately represented in tool history');
  assert.match(treeText(piInspectionGroup), /Run is idle/);
  assert.match(treeText(piInspectionGroup), /Recent conversation excerpt/);

  const channelCall = { id: 'slack-call', name: 'slack_read_channel', arguments: { channelId: 'C1' } };
  history = [
    { role: 'assistant', id: 'mixed-tool-step', toolCalls: [statusCall, channelCall, readCall] },
    { role: 'tool', toolCallId: statusCall.id, toolName: statusCall.name, content: 'Run status failed.', isError: true },
    { role: 'tool', toolCallId: channelCall.id, toolName: channelCall.name, content: 'Slack read failed.', isError: true },
  ];
  await chat.refreshTranscript();
  assert.equal(transcript.children.length, 3, 'a non-Pi call separates adjacent Pi management groups');
  assert.equal(transcript.children[0].toolList.children.length, 1);
  assert.equal(transcript.children[1].toolList.children.length, 1);
  assert.equal(transcript.children[2].toolList.children.length, 1);
  assert.match(treeText(transcript.children[0]), /pi_sessions · error/);
  assert.match(treeText(transcript.children[1]), /slack_read_channel · error/);
  assert.match(treeText(transcript.children[2]), /pi_sessions · running/);

  const wireMessage = (sequence, role, content) => {
    const message = { role, content };
    return { ...message, id: `${backendSessionId}:${sequence}`, sequence, revision: JSON.stringify(message), prefixRevision: `before-${sequence}` };
  };
  historyOverride = {
    messages: [
      wireMessage(4, 'user', 'discard duplicate'),
      wireMessage(3, 'assistant', 'Out-of-order assistant'),
      wireMessage(4, 'user', 'Duplicate ID resolved'),
    ],
    sessionId: backendSessionId, reset: false, incremental: true,
  };
  await pollNow();
  assert.equal(transcript.children.length, 5, 'out-of-order and duplicate IDs merge into one ordered transcript');
  assert.match(treeText(transcript), /pi_sessions[\s\S]*slack_read_channel[\s\S]*pi_sessions[\s\S]*Out-of-order assistant[\s\S]*Duplicate ID resolved/);
  assert.doesNotMatch(treeText(transcript), /discard duplicate/);
  backendSessionId = 'friday-session-b';
  history = [{ role: 'user', content: 'New session transcript' }];
  await pollNow();
  assert.match(treeText(transcript), /New session transcript/);
  assert.doesNotMatch(treeText(transcript), /Out-of-order assistant|Duplicate ID resolved/);

  fridayBusy = true;
  delegatedTask = { status: 'running', label: 'Build billing API' };
  await chat.enterView();
  assert.equal(elements.get('friday-status').textContent, 'Pi is working: Build billing API');
  delegatedTask = { status: 'reviewing', label: 'Build billing API', review: { stage: 'queued', queuedAt: new Date(Date.now() - 65_000).toISOString() } };
  await chat.refreshTranscript();
  assert.equal(elements.get('friday-status').textContent, 'Friday is reviewing: Build billing API');
  assert.match(elements.get('friday-status').title, /Review waiting · 1m/);
  delegatedTask = { status: 'reviewing', label: 'Build billing API', review: { stage: 'active', startedAt: new Date(Date.now() - 5_000).toISOString() } };
  await chat.refreshTranscript();
  assert.match(elements.get('friday-status').title, /Review active · [0-9]+s/);
  delegatedTask = {
    id: 'task-completed', status: 'completed', label: 'Build billing API',
    summary: 'Verified the billing API export, updated the generated types, and added integration coverage.',
    detail: 'Pi finished; Friday is checking the result against the original request.',
    review: { stage: 'finished', finishedAt: new Date().toISOString() },
  };
  await chat.refreshTranscript();
  const taskBoard = elements.get('friday-task-board');
  assert.equal(elements.get('friday-task-panel').hidden, false);
  assert.doesNotMatch(treeText(taskBoard), /Pi finished; Friday is checking/);
  assert.doesNotMatch(elements.get('friday-status').title, /Pi finished; Friday is checking/);
  const taskRow = taskBoard.children[0];
  assert.match(taskRow.children[0].textContent, /Build billing API · completed/);
  const taskDetails = taskRow.children.find((child) => child.className === 'friday-task-details');
  assert.ok(taskDetails, 'full task description is available through a native disclosure');
  assert.match(taskDetails.children[0].textContent, /Verified the billing API export/);
  assert.equal(taskDetails.children[1].textContent, delegatedTask.summary);
  taskDetails.open = true;
  taskBoard.scrollTop = 36;
  let taskChildren = taskBoard.children;
  Object.defineProperty(taskBoard, 'children', {
    configurable: true,
    get: () => new Proxy(taskChildren, { get: (target, key) => key === 'filter' ? undefined : Reflect.get(target, key, target) }),
    set: (value) => { taskChildren = value; },
  });
  delegatedTask = { ...delegatedTask, review: { ...delegatedTask.review, errorCode: 'checked' } };
  await chat.refreshTranscript();
  assert.equal(taskBoard.children[0].children.find((child) => child.className === 'friday-task-details').open, true, 'polling preserves expanded task details');
  assert.equal(taskBoard.scrollTop, 36, 'polling preserves the task list scroll position');
  assert.equal([...timers.values()][0].delay, 2_000, 'busy Friday conversations poll more frequently');
  assert.equal(composer.disabled, false, 'the composer stays available during an active Friday response');
  assert.equal(elements.get('friday-stop').hidden, false, 'stopping the active response is a separate control');
  const form = elements.get('friday-form');
  const submit = form.listeners.get('submit');
  composer.value = 'follow-up while busy';
  composer.listeners.get('input')();
  assert.equal(elements.get('friday-send').disabled, false);
  await submit({ preventDefault() {} });
  assert.equal(queuedPosts.at(-1).message, 'follow-up while busy');
  assert.equal(chatJobs.find((job) => job.id === queuedPosts.at(-1).id).status, 'queued');
  composer.value = 'another follow-up';
  composer.listeners.get('input')();
  await submit({ preventDefault() {} });
  const [activeJob, queuedJob] = queuedPosts.slice(-2);
  chatJobs = [
    { id: activeJob.id, status: 'running', position: 0 },
    { id: queuedJob.id, status: 'queued', position: 1 },
  ];
  await chat.refreshTranscript();
  const queueRows = elements.get('friday-chat-queue').children;
  assert.equal(queueRows.length, 2, 'active and queued messages have visible per-message state');
  assert.match(treeText(queueRows[1]), /Queued · 1/);
  assert.match(treeText(queueRows[1]), /Cancel queued message/);
  queueRows[1].children.find((child) => child.textContent === 'Cancel queued message').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancelledJobs, [queuedJob.id], 'only the specifically queued message is cancelled');
  assert.deepEqual(chatJobs.map((job) => job.id), [activeJob.id], 'cancellation leaves the active message untouched');
  chat.stop();
});
