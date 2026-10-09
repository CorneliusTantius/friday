import { formatPercent } from './dashboard-format.js';
import { renderMarkdown as renderMarkdownDocument } from './markdown.js';
import { createFridayPiSessionCards, fetchAndRenderCurrent, generatePiSessionName } from './friday-pi-session-cards.js';

const fridayChatModule = await import('./friday-chat.js').catch(() => null);

const $ = (selector) => document.querySelector(selector);

const elements = {
  messages: $('#messages'), form: $('#chat-form'), input: $('#message'), send: $('#send'), reset: $('#reset'),
  refreshSessions: $('#refresh-sessions'), sessionList: $('#session-list'), status: $('#status'),
  contextUsage: $('#pi-context-usage'), contextProgress: $('#pi-context-progress'), contextLabel: $('#pi-context-label'),
  workspace: $('#workspace'), workspaceOptions: $('#workspace-options'), model: $('#model'),
  thinkingLevel: $('#thinking-level'), jumpLatest: $('#jump-latest'),
  fileList: $('#file-list'), filesPathLabel: $('#files-path'), filesUp: $('#files-up'), filesRootLabel: $('#files-root'),
  fileTitle: $('#file-title'), fileMeta: $('#file-meta'), fileContent: $('#file-content'),
  fileEditorLayout: $('#file-editor-layout'), fileEditor: $('#file-editor'), fileMarkdownPreview: $('#file-markdown-preview'),
  fileEditActions: $('#file-edit-actions'), fileEditStatus: $('#file-edit-status'), fileEdit: $('#file-edit'), fileSave: $('#file-save'), fileCancel: $('#file-cancel'),
  deviceList: $('#device-list'), deviceStatus: $('#device-status'),
  fridaySettingsList: $('#friday-settings-list'), settingsList: $('#settings-list'),
  serverSettingsList: $('#server-settings-list'), extensionsList: $('#extensions-list'),
  piExtensionsUpdateStatus: $('#pi-extensions-update-status'), piRuntimeUpdateStatus: $('#pi-runtime-update-status'),
  toastRegion: $('#toast-region'), drawerBackdrop: $('#drawer-backdrop'), agentOrb: $('.header .agent-orb'),
  logout: $('#logout'),
  financeForm: $('#finance-form'), financeList: $('#finance-list'), financeStatus: $('#finance-status'),
  financeBalance: $('#finance-balance'), financeIncome: $('#finance-income'), financeExpenses: $('#finance-expenses'),
  financeSubmit: $('#finance-submit'), financeCancel: $('#finance-cancel'),
  fridayPiSessionList: $('#friday-pi-session-list'), fridayPiSessionsRefresh: $('#friday-pi-sessions-refresh'),
  fridayPiSessionsToggle: $('#friday-pi-sessions-toggle'), fridayReviewMemory: $('#friday-review-memory'),
  fridayNavEntry: $('#friday-nav-entry'), fridaySubmenuToggle: $('#friday-submenu-toggle'), fridayWorkspaceDirectory: $('#friday-workspace-directory'),
  financeSummaryPeriod: $('#finance-summary-period'), financeMonth: $('#finance-month'),
  financeTypeFilter: $('#finance-type-filter'), financeCategoryFilter: $('#finance-category-filter'),
  financeExport: $('#finance-export'),
  announcement: $('#announcement'),
};

const featureButtons = [...document.querySelectorAll('[data-feature]')];
const featureViews = new Map([
  ['friday', $('#friday-feature')],
  ['pi', $('#pi-feature')],
  ['files', $('#files-feature')], ['pi-files', $('#files-feature')],
  ['repos', $('#repos-feature')], ['notes', $('#notes-feature')],
  ['finances', $('#finances-feature')], ['socials', $('#socials-feature')], ['calendar', $('#calendar-feature')],
  ['dashboard', $('#dashboard-feature')], ['settings', $('#settings-feature')], ['friday-settings', $('#settings-feature')], ['pi-settings', $('#settings-feature')],
]);
const url = new URL(window.location.href);
const requestedFeature = url.searchParams.get('feature');
const initialFeatureName = featureViews.has(requestedFeature) ? requestedFeature : 'dashboard';
const initialFeature = ['friday-settings', 'pi-settings'].includes(initialFeatureName) ? 'settings' : initialFeatureName;
if (requestedFeature) {
  url.searchParams.delete('feature');
  history.replaceState(null, '', url);
}

const state = {
  activeFeature: initialFeature,
  fileFeature: initialFeatureName === 'pi-files' ? 'pi-files' : initialFeatureName === 'files' ? 'files' : sessionStorage.getItem('friday-files-scope') === 'pi' ? 'pi-files' : 'files',
  activeModel: '',
  activeThinkingLevel: 'off',
  agentBusy: false,
  canAbort: false,
  stopping: false,
  initializing: true,
  locks: new Set(),
  contextVersion: 0,
  history: [],
  historyTotal: 0,
  files: {
    files: { root: '', path: '', selectedFilePath: '' },
    'pi-files': { root: '', path: '', selectedFilePath: '' },
  },
  currentSessionPath: null,
  workspace: '',
  fridayWorkspace: '',
};

const requests = new Map();
let suggestionTimer;
let suggestionSequence = 0;
let pollTimer = null;
let pollInFlight = false;
const activePollInterval = 2_000;
const idlePollInterval = 15_000;

const createClientId = () => globalThis.crypto?.randomUUID?.() || `friday-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clientSessionId = sessionStorage.getItem('friday-session-id') || createClientId();
const browserClientId = sessionStorage.getItem('friday-client-id') || createClientId();
sessionStorage.setItem('friday-session-id', clientSessionId);
sessionStorage.setItem('friday-client-id', browserClientId);

const icons = {
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z"/></svg>',
};

function apiFetch(resource, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Friday-Session', sessionStorage.getItem('friday-session-id') || clientSessionId);
  headers.set('X-Friday-Client', browserClientId);
  return fetch(resource, { ...options, headers });
}

let authRedirecting = false;

function redirectToLogin() {
  if (authRedirecting) return;
  authRedirecting = true;
  window.location.replace('/login?notice=login-required');
}

async function apiJson(resource, options = {}, requestKey = null) {
  let controller;
  if (requestKey) {
    requests.get(requestKey)?.abort();
    controller = new AbortController();
    requests.set(requestKey, controller);
  }
  try {
    const response = await apiFetch(resource, { ...options, signal: controller?.signal ?? options.signal });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && data.error === 'Login required') redirectToLogin();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  } finally {
    if (requestKey && requests.get(requestKey) === controller) requests.delete(requestKey);
  }
}

function cancelRequest(key) {
  requests.get(key)?.abort();
  requests.delete(key);
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

function toast(message, type = '') {
  const item = document.createElement('div');
  item.className = `toast${type ? ` ${type}` : ''}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

function lock(name, active) {
  if (active) state.locks.add(name);
  else state.locks.delete(name);
  updateControls();
}

function updateControls() {
  const mutating = state.initializing || state.locks.size > 0;
  const unavailable = state.initializing;
  elements.input.disabled = unavailable || state.agentBusy || state.locks.has('chat');
  const stopAvailable = state.canAbort && !state.stopping && !unavailable;
  elements.send.disabled = stopAvailable ? false : unavailable || state.agentBusy || state.locks.has('chat') || !elements.input.value.trim();
  const sendMode = stopAvailable ? 'stop' : 'send';
  if (elements.send.dataset.mode !== sendMode) {
    elements.send.dataset.mode = sendMode;
    elements.send.innerHTML = stopAvailable
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-5 14-2.5-5.5L5 12Z"/></svg>';
  }
  elements.send.classList.toggle('stop', stopAvailable);
  elements.send.setAttribute('aria-label', stopAvailable ? 'Stop response' : 'Send message');
  elements.send.title = stopAvailable ? 'Stop response' : 'Send message';
  elements.reset.disabled = unavailable || state.locks.has('session');
  elements.workspace.disabled = unavailable || state.locks.has('workspace') || state.locks.has('session-management');
  elements.model.disabled = unavailable || state.agentBusy || state.locks.has('model') || !elements.model.options.length;
  elements.thinkingLevel.disabled = unavailable || state.agentBusy || state.locks.has('thinking') || !elements.thinkingLevel.options.length;
  elements.agentOrb?.classList.toggle('working', state.agentBusy);

  if (state.initializing) elements.status.textContent = 'Starting…';
  else if (state.agentBusy) elements.status.textContent = 'Pi is working…';
  else if (state.locks.has('session-management')) elements.status.textContent = 'Managing sessions…';
  else if (state.locks.has('workspace')) elements.status.textContent = 'Changing workspace…';
  else if (state.locks.has('session')) elements.status.textContent = 'Opening session…';
  else if (state.locks.has('model')) elements.status.textContent = 'Changing model…';
  else if (state.locks.has('thinking')) elements.status.textContent = 'Updating thinking…';
  else if (mutating) elements.status.textContent = 'Working…';
  else elements.status.textContent = 'Ready';
}

function setAgentBusy(busy, canAbort = busy) {
  state.agentBusy = busy;
  state.canAbort = busy && canAbort;
  updateControls();
}

function pretty(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function renderMarkdown(parent, source) {
  renderMarkdownDocument(parent, source, appendHighlightedCode);
}

function renderSignature(value) {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  }
  return `${source.length}:${hash >>> 0}`;
}

function createSystemEntry(title, body, isError = false) {
  const details = document.createElement('details');
  details.className = `system-entry${isError ? ' error' : ''}`;
  const summary = document.createElement('summary'); summary.textContent = title; details.append(summary);
  if (body) { const pre = document.createElement('pre'); pre.textContent = body; details.append(pre); }
  return details;
}

function addSystemEntry(title, body, isError = false, target = elements.messages) {
  const entry = createSystemEntry(title, body, isError);
  entry.renderSignature = renderSignature({ title, body, isError });
  target.append(entry);
}

function addCompactionSummary(message, target = elements.messages) {
  const entry = document.createElement('details');
  entry.className = 'system-entry compaction-summary';
  entry.open = true;
  const heading = document.createElement('summary'); heading.textContent = 'Context summary · Pi compacted earlier history';
  const body = document.createElement('div'); body.className = 'message-content compaction-summary-body'; renderMarkdown(body, message.content);
  entry.append(heading, body);
  entry.renderSignature = renderSignature(message);
  target.append(entry);
}

function toolSummary(records) {
  const counts = new Map();
  for (const { call } of records) {
    const name = call.name || 'tool';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const names = [...counts].map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ''}`).join(', ');
  const errors = records.filter(({ result }) => result?.isError).length;
  return `${records.length} tool call${records.length === 1 ? '' : 's'} · ${names}${errors ? ` · ${errors} failed` : ''}`;
}

function addToolGroup(records, target = elements.messages) {
  if (!records.length) return;
  const group = document.createElement('details');
  group.renderSignature = renderSignature(records);
  group.className = 'tool-group';
  const summary = document.createElement('summary');
  summary.textContent = toolSummary(records);
  const list = document.createElement('div');
  list.className = 'tool-group-list';

  records.forEach(({ call, result }, index) => {
    const isError = result?.isError === true;
    const status = result ? isError ? 'error' : 'complete' : 'running';
    const sections = [`Call\n${pretty(call.arguments)}`];
    if (result) sections.push(`Result\n${result.content || '(empty)'}`);
    const entry = createSystemEntry(`${call.name} · ${status}`, sections.join('\n\n'), isError);
    entry.renderIdentity = call.id || `${call.name || 'tool'}:${index}`;
    list.append(entry);
  });

  group.append(summary, list);
  target.append(group);
}

function createPiLogo(className) {
  const logo = document.createElement('div'); logo.className = className; logo.setAttribute('aria-hidden', 'true');
  logo.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5v2h2v12h2V7h6v9a3 3 0 0 0 6 0h-2a1 1 0 0 1-2 0V7h2V5z"/></svg>';
  return logo;
}

function addMessage(message, target = elements.messages) {
  if (message.role === 'tool') {
    addSystemEntry(`${message.isError ? 'Error' : 'Result'} · ${message.toolName || 'tool'}`, message.content, message.isError, target);
    return;
  }
  if (!message.content) return;
  const item = document.createElement('article'); item.className = `message ${message.role}`;
  item.renderSignature = renderSignature(message);;
  const body = document.createElement('div'); body.className = 'message-body';
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = message.role === 'user' ? 'You' : 'Pi Agent';
  const text = document.createElement('div'); text.className = 'message-content'; renderMarkdown(text, message.content);
  body.append(label, text);
  if (message.role === 'user') item.append(body);
  else {
    item.append(createPiLogo('message-avatar'), body);
  }
  target.append(item);
}

function renderWelcome(target = elements.messages) {
  const welcome = document.createElement('div'); welcome.className = 'welcome';
  welcome.renderSignature = 'welcome';
  const logo = createPiLogo('welcome-pi-logo');
  const title = document.createElement('h2'); title.textContent = 'What should we build?';
  const copy = document.createElement('p'); copy.textContent = 'Ask Friday to inspect code, fix a bug, plan a feature, or work directly in your current workspace.';
  welcome.append(logo, title, copy); target.append(welcome);
}

function historyEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeHistoryTail(tail, total) {
  if (!Number.isInteger(total) || total < state.historyTotal) return null;
  if (!state.history.length || total <= tail.length) return tail;
  const prefixLength = total - tail.length;
  if (state.history.length <= prefixLength) return null;
  if (!historyEqual(state.history[prefixLength], tail[0])) return null;
  return [...state.history.slice(0, prefixLength), ...tail];
}

function preserveDisclosureState(current, replacement) {
  if (!(current instanceof HTMLDetailsElement) || !(replacement instanceof HTMLDetailsElement)) return;
  replacement.open = current.open;
  const openTools = new Map(
    [...current.querySelectorAll('details')]
      .filter((item) => item.renderIdentity)
      .map((item) => [item.renderIdentity, item.open]),
  );
  for (const item of replacement.querySelectorAll('details')) {
    if (openTools.has(item.renderIdentity)) item.open = openTools.get(item.renderIdentity);
  }
}

function reconcileMessages(nextContainer) {
  const current = [...elements.messages.children];
  const next = [...nextContainer.children];
  const length = Math.max(current.length, next.length);
  for (let index = 0; index < length; index += 1) {
    const existing = current[index];
    const replacement = next[index];
    if (!replacement) {
      existing?.remove();
    } else if (!existing) {
      elements.messages.append(replacement);
    } else if (existing.renderSignature !== replacement.renderSignature) {
      preserveDisclosureState(existing, replacement);
      existing.replaceWith(replacement);
    }
  }
}

function renderHistory(history) {
  const nextContainer = document.createElement('div');
  if (!history.length) {
    renderWelcome(nextContainer);
    reconcileMessages(nextContainer);
    return;
  }

  const pendingToolCalls = new Map();
  let toolGroup = [];
  const flushToolGroup = () => {
    addToolGroup(toolGroup, nextContainer);
    toolGroup = [];
    pendingToolCalls.clear();
  };

  for (const message of history) {
    if (message.role === 'compaction') {
      flushToolGroup();
      addCompactionSummary(message, nextContainer);
      continue;
    }
    if (message.role === 'tool') {
      const record = pendingToolCalls.get(message.toolCallId);
      if (record) record.result = message;
      else toolGroup.push({
        call: { name: message.toolName || 'tool', arguments: {} },
        result: message,
      });
      continue;
    }

    if (message.content) {
      flushToolGroup();
      addMessage(message, nextContainer);
    }

    for (const toolCall of message.toolCalls || []) {
      const record = { call: toolCall, result: null };
      toolGroup.push(record);
      pendingToolCalls.set(toolCall.id, record);
    }
  }

  flushToolGroup();
  reconcileMessages(nextContainer);
}

function nearBottom() {
  return elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 100;
}

function scrollToLatest(behavior = 'smooth') {
  elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior });
  elements.jumpLatest.hidden = true;
}

function captureScrollAnchor() {
  const containerTop = elements.messages.getBoundingClientRect().top;
  const children = [...elements.messages.children];
  const index = children.findIndex((child) => child.getBoundingClientRect().bottom >= containerTop);
  if (index < 0) return null;
  return {
    index,
    signature: children[index].renderSignature,
    offset: children[index].getBoundingClientRect().top - containerTop,
  };
}

function restoreScrollAnchor(anchor, fallbackScrollTop) {
  if (!anchor) {
    elements.messages.scrollTop = fallbackScrollTop;
    return;
  }
  const children = [...elements.messages.children];
  let target = children[anchor.index];
  if (target?.renderSignature !== anchor.signature) {
    target = children.find((child) => child.renderSignature === anchor.signature);
  }
  if (!target) {
    elements.messages.scrollTop = fallbackScrollTop;
    return;
  }
  const containerTop = elements.messages.getBoundingClientRect().top;
  elements.messages.scrollTop += target.getBoundingClientRect().top - containerTop - anchor.offset;
}

async function loadHistory({ forceScroll = false, limit = null } = {}) {
  const context = state.contextVersion;
  const stick = forceScroll || nearBottom();
  const previousScrollTop = elements.messages.scrollTop;
  const scrollAnchor = stick ? null : captureScrollAnchor();
  const endpoint = limit ? `/api/history?limit=${limit}` : '/api/history';
  let data = await apiJson(endpoint, {}, 'history');
  if (context !== state.contextVersion) return;
  let next = limit ? mergeHistoryTail(data.messages, data.total) : data.messages;
  if (!next) {
    data = await apiJson('/api/history', {}, 'history');
    if (context !== state.contextVersion) return;
    next = data.messages;
  }
  if (!historyEqual(state.history, next)) {
    const previousAssistant = [...state.history].reverse().find((message) => message.role === 'assistant')?.content;
    const latestAssistant = [...next].reverse().find((message) => message.role === 'assistant')?.content;
    state.history = next;
    renderHistory(next);
    if (!state.initializing && latestAssistant && latestAssistant !== previousAssistant) {
      elements.announcement.textContent = `Pi Agent: ${latestAssistant}`;
    }
    if (stick) scrollToLatest(forceScroll ? 'smooth' : 'auto');
    else {
      restoreScrollAnchor(scrollAnchor, previousScrollTop);
      elements.jumpLatest.hidden = false;
    }
  }
  state.historyTotal = data.total;
  state.currentSessionPath = data.sessionPath;
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function piViewVisible() {
  return document.visibilityState !== 'hidden'
    && state.activeFeature === 'pi'
    && elements.messages.isConnected
    && elements.messages.getClientRects().length > 0;
}

function schedulePoll(delay = state.agentBusy ? activePollInterval : idlePollInterval) {
  stopPolling();
  if (!piInitialized || !piViewVisible() || state.locks.has('session') || state.locks.has('workspace') || state.locks.has('session-management')) return;
  pollTimer = setTimeout(() => void pollHistory(), delay);
}

async function pollHistory() {
  if (!piViewVisible() || state.locks.has('session') || state.locks.has('workspace') || state.locks.has('session-management')) {
    stopPolling();
    return;
  }
  if (pollInFlight) { schedulePoll(500); return; }
  const context = state.contextVersion;
  pollInFlight = true;
  try {
    const data = await apiJson('/api/status', {}, 'poll-status');
    if (context !== state.contextVersion) return;
    setAgentBusy(data.busy, data.canAbort === true);
    renderPiContextUsage(data.contextUsage);
    await Promise.all([
      loadHistory({ limit: data.busy ? 10 : null }),
      loadSessions(elements.workspace.value, { quiet: true }),
    ]);
  } catch {
  } finally {
    pollInFlight = false;
    if (context === state.contextVersion) schedulePoll(state.agentBusy ? activePollInterval : idlePollInterval);
  }
}

function startPolling(delay = 0) {
  schedulePoll(delay);
}

function setWorkspaceSuggestions(items) {
  elements.workspaceOptions.replaceChildren();
  for (const option of items) {
    const item = document.createElement('option'); item.value = option.path; item.label = option.label; elements.workspaceOptions.append(item);
  }
}

async function loadWorkspaceSuggestions(prefix = '') {
  const sequence = ++suggestionSequence;
  try {
    const data = await apiJson(`/api/workspaces?prefix=${encodeURIComponent(prefix)}`, {}, 'suggestions');
    if (sequence === suggestionSequence) setWorkspaceSuggestions(data.workspaces);
  } catch {}
}

function sessionState(item) {
  if (item.busy) return { label: `Working${item.queuedPrompts ? ` · ${item.queuedPrompts} queued` : ''}`, className: 'working' };
  if (item.queuedPrompts) return { label: `${item.queuedPrompts} queued`, className: 'working' };
  if (item.running) return { label: 'Open', className: 'running' };
  return { label: 'Saved', className: 'saved' };
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatLocalTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

let currentPiSessions = [];

function renderSessions(items, currentPath) {
  currentPiSessions = items;
  elements.sessionList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state'; empty.innerHTML = '<div><strong>No sessions yet</strong><span class="empty-copy">Start a conversation to create one.</span></div>';
    elements.sessionList.append(empty); return;
  }
  for (const item of items) {
    const card = document.createElement('div');
    card.className = `session-item${item.path === currentPath ? ' selected' : ''}`;
    const openButton = document.createElement('button');
    openButton.type = 'button'; openButton.className = 'session-open'; openButton.title = item.preview || item.path;
    if (item.path === currentPath) openButton.setAttribute('aria-current', 'true');
    const title = document.createElement('span'); title.className = 'session-title'; title.textContent = item.name;
    const details = document.createElement('span'); details.className = 'session-details';
    const meta = document.createElement('span'); meta.className = 'session-meta'; meta.textContent = `${formatDate(item.modified)} · ${item.messageCount} msg`;
    const sessionStatus = sessionState(item);
    const statusLabel = document.createElement('span'); statusLabel.className = `session-state ${sessionStatus.className}`; statusLabel.textContent = sessionStatus.label;
    details.append(meta, statusLabel); openButton.append(title, details);
    openButton.addEventListener('click', () => {
      if (state.locks.has('session')) return;
      closeDrawer();
      const currentRuntimeId = sessionStorage.getItem('friday-session-id');
      if (item.path === currentPath && item.runtimeId === currentRuntimeId) return;
      card.classList.add('loading');
      if (item.runtimeId && item.runtimeId !== currentRuntimeId) { attachRuntime(item.runtimeId); return; }
      void openSession(item.path);
    });

    const actions = document.createElement('div'); actions.className = 'session-actions';
    const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'session-action'; rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${item.name}`);
    rename.addEventListener('click', () => void manageSession('rename', item));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'session-action danger'; remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${item.name}`);
    remove.addEventListener('click', () => void manageSession('delete', item));
    actions.append(rename, remove);
    card.append(openButton, actions);
    elements.sessionList.append(card);
  }
}

async function manageSession(action, item) {
  if (state.locks.has('session')) return;
  const suggestion = action === 'rename' ? generatePiSessionName(currentPiSessions, item.path) : null;
  const name = action === 'rename'
    ? window.prompt('Rename session (suggested name)', suggestion)?.trim()
    : null;
  if (action === 'rename' && (!name || name === item.name)) return;
  if (action === 'delete' && !window.confirm(`Delete “${item.name}”? This permanently removes the saved session.`)) return;

  lock('session', true);
  lock('session-management', true);
  const context = state.contextVersion;
  try {
    const data = await apiJson(`/api/session/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: elements.workspace.value, path: item.path, ...(name ? { name } : {}) }),
    }, 'session-action');
    if (context !== state.contextVersion) return;
    if (action === 'delete' && data.runtimeId !== sessionStorage.getItem('friday-session-id')) {
      attachRuntime(data.runtimeId);
      return;
    }
    await loadSessions(elements.workspace.value);
    toast(action === 'rename' ? 'Session renamed' : 'Session deleted');
  } catch (error) {
    if (!isAbort(error)) toast(error.message, 'error');
  } finally {
    lock('session-management', false);
    lock('session', false);
  }
}


async function loadSessions(cwd = elements.workspace.value, { quiet = false } = {}) {
  const requestedWorkspace = cwd;
  if (!quiet) elements.refreshSessions.classList.add('loading');
  try {
    const data = await apiJson(`/api/sessions?cwd=${encodeURIComponent(cwd)}`, {}, 'sessions');
    if (elements.workspace.value !== requestedWorkspace && elements.workspace.value !== data.workspace) return;
    elements.workspace.value = data.workspace;
    state.currentSessionPath = data.currentSession;
    renderSessions(data.sessions, data.currentSession);
  } finally {
    elements.refreshSessions.classList.remove('loading');
  }
}

function attachRuntime(runtimeId) {
  sessionStorage.setItem('friday-session-id', runtimeId);
  window.location.assign('/?feature=pi');
}

async function openSession(sessionPath) {
  if (state.locks.has('session')) return;
  if (sessionPath !== state.currentSessionPath) clearPiSessionNameSuggestion();
  closeDrawer();
  lock('session', true);
  const context = ++state.contextVersion;
  stopPolling();
  cancelRequest('history');
  try {
    const data = await apiJson('/api/session/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: elements.workspace.value, path: sessionPath }),
    }, 'session-action');
    if (context !== state.contextVersion) return;
    if (data.runtimeId && data.runtimeId !== sessionStorage.getItem('friday-session-id')) { attachRuntime(data.runtimeId); return; }
    state.history = [];
    state.historyTotal = 0;
    await Promise.all([loadHistory({ forceScroll: true }), loadModels(), loadThinkingLevels(), loadSessions(data.workspace)]);
    renderPiContextUsage((await apiJson('/api/status', {}, 'poll-status')).contextUsage);
    closeDrawer();
  } catch (error) {
    if (!isAbort(error)) toast(error.message, 'error');
  } finally {
    lock('session', false);
    schedulePoll(0);
    elements.input.focus();
  }
}

async function loadModels() {
  const data = await apiJson('/api/models', {}, 'models');
  elements.model.replaceChildren();
  for (const item of data.models) {
    const option = document.createElement('option'); option.value = `${item.provider}/${item.id}`; option.textContent = item.name || item.id; option.title = `${item.provider}/${item.id}`; elements.model.append(option);
  }
  state.activeModel = data.current ? `${data.current.provider}/${data.current.id}` : '';
  elements.model.value = state.activeModel;
  updateControls();
}

async function loadThinkingLevels() {
  const data = await apiJson('/api/thinking-levels', {}, 'thinking-levels');
  elements.thinkingLevel.replaceChildren();
  for (const level of data.levels) {
    const option = document.createElement('option'); option.value = level; option.textContent = level[0].toUpperCase() + level.slice(1); elements.thinkingLevel.append(option);
  }
  state.activeThinkingLevel = data.current || data.levels[0] || 'off';
  elements.thinkingLevel.value = state.activeThinkingLevel;
  updateControls();
}

async function loadWorkspace() {
  const [current, data] = await Promise.all([apiJson('/api/status', {}, 'initial-status'), apiJson('/api/workspaces', {}, 'initial-workspaces')]);
  setWorkspaceSuggestions(data.workspaces);
  elements.workspace.value = current.preferredWorkspace || current.workspace;
  state.workspace = elements.workspace.value;
  setAgentBusy(current.busy, current.canAbort === true);
  renderPiContextUsage(current.contextUsage);
  await loadSessions(elements.workspace.value);
}

function formatContextTokens(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function renderPiContextUsage(usage) {
  if (!elements.contextUsage) return;
  const tokens = formatContextTokens(usage?.tokens);
  const windowSize = formatContextTokens(usage?.contextWindow);
  const rawPercent = Number.isFinite(usage?.percent)
    ? usage.percent
    : Number.isFinite(usage?.tokens) && Number.isFinite(usage?.contextWindow) && usage.contextWindow > 0
      ? usage.tokens / usage.contextWindow * 100
      : null;
  const percent = rawPercent === null ? null : Math.max(0, Math.min(100, rawPercent));
  elements.contextProgress.value = percent ?? 0;
  elements.contextUsage.classList.toggle('warning', percent >= 80 && percent < 95);
  elements.contextUsage.classList.toggle('critical', percent >= 95);
  const percentLabel = percent === null ? '' : percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
  elements.contextLabel.textContent = percent === null
    ? 'Unavailable'
    : tokens && windowSize ? `${tokens} / ${windowSize} (${percentLabel})` : percentLabel;
  elements.contextUsage.title = percent === null
    ? 'Context usage is not available yet'
    : tokens && windowSize
      ? `${Math.round(usage.tokens).toLocaleString()} of ${Math.round(usage.contextWindow).toLocaleString()} context tokens (${percent.toFixed(1)}%)`
      : `${percent.toFixed(1)}% of the context window used`;
  elements.contextProgress.setAttribute('aria-valuetext', percent === null ? 'Unavailable' : `${percent.toFixed(1)} percent`);
}

const fileLanguages = {
  js: 'javascript', javascript: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  py: 'python', python: 'python', rb: 'ruby', ruby: 'ruby', go: 'go', rs: 'rust', rust: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', php: 'php',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', md: 'markdown', markdown: 'markdown', diff: 'diff',
  dockerfile: 'dockerfile', makefile: 'makefile',
};

function appendHighlightedCode(parent, content, languageHint = '') {
  const code = document.createElement('code');
  const language = fileLanguages[languageHint.toLowerCase()] || languageHint.toLowerCase();
  if (language && window.hljs?.getLanguage(language)) {
    code.className = `hljs language-${language}`;
    try { code.innerHTML = window.hljs.highlight(content, { language, ignoreIllegals: true }).value; }
    catch { code.textContent = content; }
  } else {
    code.textContent = content;
  }
  parent.append(code);
}

function renderFilePreview(content, path) {
  const fileName = path.split('/').at(-1).toLowerCase();
  const extension = fileName.includes('.') ? fileName.split('.').at(-1) : fileName;
  const language = fileLanguages[extension] || extension;
  elements.fileContent.replaceChildren();
  appendHighlightedCode(elements.fileContent, content, language);
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUsage(usage) {
  if (!usage) return 'Unavailable';
  return `${usage.memoryPercent.toFixed(1)}% memory · ${usage.cpuPercent.toFixed(1)}% CPU · ${usage.load1.toFixed(2)} load`;
}

function renderFiles(data, feature) {
  const files = state.files[feature];
  files.root = data.root; files.path = data.path;
  elements.filesRootLabel.textContent = `${feature === 'files' ? 'Friday Files' : 'Pi Files'} · ${data.directory || (feature === 'files' ? '~/.friday' : '~/.pi')}`;
  elements.filesPathLabel.textContent = data.path ? `/${data.path}` : '/'; elements.filesPathLabel.title = elements.filesPathLabel.textContent;
  elements.filesUp.disabled = !data.path; elements.fileList.replaceChildren();
  if (!data.entries.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state'; empty.innerHTML = '<div><strong>Empty folder</strong><span class="empty-copy">Nothing to show here.</span></div>'; elements.fileList.append(empty); return;
  }
  for (const entry of data.entries) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `file-item${entry.path === files.selectedFilePath ? ' selected' : ''}`; button.title = entry.path;
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.innerHTML = entry.type === 'directory' ? icons.folder : icons.file;
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = entry.name; button.append(icon, name);
    if (entry.type === 'file') {
      const size = document.createElement('span'); size.className = 'file-size'; size.textContent = formatBytes(entry.size); button.append(size);
      button.addEventListener('click', () => void loadFile(entry.path));
    } else button.addEventListener('click', () => void loadFiles(entry.path));
    elements.fileList.append(button);
  }
}

function fileHasUnsavedChanges() {
  return !elements.fileEditorLayout.hidden && elements.fileEditor.value !== elements.fileEditor.dataset.original;
}

function confirmDiscardFileChanges() {
  return !fileHasUnsavedChanges() || window.confirm('Discard unsaved file changes?');
}

async function loadFiles(path = state.files[state.activeFeature]?.path || '') {
  if (!confirmDiscardFileChanges()) return;
  const context = state.contextVersion;
  const feature = state.activeFeature;
  const files = state.files[feature];
  try {
    const scope = feature === 'files' ? 'friday' : 'pi';
    const data = await apiJson(`/api/${scope}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`, {}, `files-${feature}`);
    if (context !== state.contextVersion || state.activeFeature !== feature) return;
    renderFiles(data, feature);
  } catch (error) {
    if (isAbort(error)) return;
    elements.fileContent.textContent = error.message; elements.fileTitle.textContent = 'Files unavailable'; elements.fileMeta.textContent = '';
    toast(error.message, 'error');
  }
}

async function loadFile(path) {
  if (!confirmDiscardFileChanges()) return;
  const context = state.contextVersion;
  const feature = state.activeFeature;
  const files = state.files[feature];
  elements.fileTitle.textContent = path.split('/').pop() || path;
  elements.fileMeta.textContent = 'Loading file…';
  elements.fileContent.hidden = false;
  elements.fileEditorLayout.hidden = true;
  elements.fileEditActions.hidden = true;
  try {
    const scope = feature === 'files' ? 'friday' : 'pi';
    const data = await apiJson(`/api/${scope}/files/content?path=${encodeURIComponent(path)}`, {}, `file-preview-${feature}`);
    if (context !== state.contextVersion || state.activeFeature !== feature) return;
    files.selectedFilePath = data.path;
    elements.fileTitle.textContent = data.path.split('/').pop() || data.path;
    const typeLabel = data.editorType === 'markdown' ? 'Markdown' : data.editorType === 'json' ? 'JSON' : 'text';
    elements.fileMeta.textContent = `${data.path} · ${formatBytes(data.size)} · ${new Date(data.modified).toLocaleString()} · ${typeLabel} editor`;
    const isMarkdown = data.editorType === 'markdown';
    elements.fileContent.hidden = isMarkdown;
    elements.fileEditorLayout.hidden = !isMarkdown;
    elements.fileEditorLayout.dataset.editorType = data.editorType;
    delete elements.fileEditorLayout.dataset.editing;
    elements.fileEditor.setAttribute('aria-label', `Edit ${typeLabel} file`);
    elements.fileEditor.value = data.content;
    elements.fileEditor.dataset.original = data.content;
    elements.fileMarkdownPreview.hidden = !isMarkdown;
    elements.fileMarkdownPreview.replaceChildren();
    if (isMarkdown) renderMarkdown(elements.fileMarkdownPreview, data.content);
    else renderFilePreview(data.content, data.path);
    elements.fileEditActions.hidden = false;
    elements.fileEditStatus.textContent = '';
    elements.fileEdit.hidden = isMarkdown;
    elements.fileSave.hidden = !isMarkdown;
    elements.fileCancel.hidden = !isMarkdown;
    elements.fileSave.disabled = true;
    for (const item of elements.fileList.querySelectorAll('.file-item')) item.classList.toggle('selected', item.title === data.path);
  } catch (error) {
    if (isAbort(error)) return;
    files.selectedFilePath = ''; elements.fileTitle.textContent = 'File unavailable'; elements.fileMeta.textContent = error.message;
    elements.fileContent.hidden = false; elements.fileContent.textContent = error.message;
    elements.fileEditorLayout.hidden = true; elements.fileEditActions.hidden = true;
  }
}

function renderDevices(data) {
  elements.deviceList.replaceChildren();
  elements.deviceStatus.className = `feature-notice${data.available ? '' : ' warning'}`;
  elements.deviceStatus.textContent = data.available ? `${data.devices.length} device${data.devices.length === 1 ? '' : 's'} visible` : data.error;
  for (const device of data.devices) {
    const card = document.createElement('article'); card.className = `device-card${device.local || device.self ? ' host' : ''}`;
    const heading = document.createElement('div'); heading.className = 'device-heading';
    const name = document.createElement('span'); name.className = 'device-name'; name.textContent = device.hostname;
    const deviceState = document.createElement('span'); deviceState.className = `device-state${device.online ? ' online' : ''}`; deviceState.textContent = device.online ? 'Online' : 'Offline'; heading.append(name, deviceState);
    const meta = document.createElement('div'); meta.className = 'device-meta'; meta.textContent = `${device.self ? 'This host' : device.os}${device.dnsName ? ` · ${device.dnsName}` : ''}`; card.append(heading, meta);
    if (device.usage) { const usage = document.createElement('div'); usage.className = 'device-usage'; usage.textContent = formatUsage(device.usage); card.append(usage); }
    if (device.addresses.length) { const addresses = document.createElement('div'); addresses.className = 'device-addresses'; addresses.textContent = device.addresses.join(' · '); card.append(addresses); }
    elements.deviceList.append(card);
  }
}

async function loadDevices() {
  const data = await apiJson('/api/devices', {}, 'devices');
  if (state.activeFeature === 'settings' || state.activeFeature === 'dashboard') renderDevices(data);
}

function renderSettingCards(container, values) {
  container.replaceChildren();
  for (const [label, value] of values) {
    const item = document.createElement('div'); item.className = 'setting-card';
    const key = document.createElement('span'); key.className = 'setting-label'; key.textContent = label;
    const content = document.createElement('span'); content.className = 'setting-value'; content.textContent = value;
    item.append(key, content); container.append(item);
  }
}

function renderPiUpdateStatus(update = {}) {
  const updating = update.state === 'updating';
  $('#update-pi-extensions').disabled = updating;
  $('#update-pi-runtime').disabled = updating;
  elements.piExtensionsUpdateStatus.textContent = update.operation === 'extensions' ? update.message : '';
  elements.piRuntimeUpdateStatus.textContent = update.operation === 'runtime' ? update.message : '';
}

function renderSettings(data) {
  const friday = data.fridayChat;
  renderSettingCards(elements.fridaySettingsList, friday ? [
    ['Status', friday.busy ? 'Working' : friday.running ? 'Ready' : 'Standby'],
    ['Conversation directory', friday.directory],
    ['Saved sessions', friday.sessionsDirectory],
  ] : [['Status', 'Restart Friday server to view chat settings']]);
  renderSettingCards(elements.settingsList, [
    ['Pi status', data.busy ? 'Working' : data.piRunning ? 'Ready' : 'Standby'],
    ['Workspace', data.workspace],
  ]);
  renderPiUpdateStatus(data.piUpdateStatus);
  renderSettingCards(elements.serverSettingsList, [
    ['System usage', formatUsage(data.systemUsage)],
    ['Server', `${data.host}:${data.port}`],
  ]);

  elements.extensionsList.replaceChildren();
  if (data.piPackagesError || !data.piPackages?.length) {
    const message = document.createElement('div'); message.className = 'setting-extension-empty';
    message.textContent = data.piPackagesError || 'No installed Pi packages found.';
    elements.extensionsList.append(message);
    return;
  }

  for (const item of data.piPackages) {
    const entry = document.createElement('div'); entry.className = 'setting-extension';
    const source = document.createElement('span'); source.className = 'setting-extension-source'; source.textContent = item.source;
    const details = document.createElement('span'); details.className = 'setting-extension-details';
    details.textContent = `${item.scope} package${item.filtered ? ' · filtered' : ''}${item.installedPath ? ` · ${item.installedPath}` : ''}`;
    entry.append(source, details); elements.extensionsList.append(entry);
  }
}

function renderRepos(list, repos) {
  list.replaceChildren();
  if (!repos.length) {
    const empty = document.createElement('div'); empty.className = 'repo-empty';
    empty.textContent = 'No repositories yet. Clone one to get started.'; list.append(empty); return;
  }
  for (const repo of repos) {
    const card = document.createElement('article'); card.className = 'repo-card';
    const heading = document.createElement('div'); heading.className = 'repo-heading';
    const name = document.createElement('strong'); name.textContent = repo.name || 'Unnamed repository';
    const branch = document.createElement('span'); branch.className = 'repo-branch'; branch.textContent = repo.branch || 'No branch';
    heading.append(name, branch);
    const path = document.createElement('div'); path.className = 'repo-path'; path.textContent = repo.path || 'Local path unavailable';
    const metrics = document.createElement('div'); metrics.className = 'repo-stats';
    for (const [label, value] of [['Staged', repo.staged], ['Unstaged', repo.unstaged], ['Untracked', repo.untracked], ['Ahead', repo.ahead], ['Behind', repo.behind]]) {
      if (value == null) continue;
      const metric = document.createElement('span'); metric.textContent = `${label} ${value}`; metrics.append(metric);
    }
    if (!metrics.children.length) metrics.textContent = Object.hasOwn(repo, 'staged') ? 'Git status unavailable' : 'Restart Friday server to load Git stats';
    card.append(heading, path, metrics);
    if (repo.latestCommit) {
      const detail = document.createElement('div'); detail.className = 'repo-commit'; detail.textContent = `Latest commit ${repo.latestCommit}`;
      card.append(detail);
    }
    const clean = repo.branch && repo.branch !== 'Detached HEAD' && repo.staged === 0 && repo.unstaged === 0 && repo.untracked === 0;
    const pull = document.createElement('button');
    pull.type = 'button';
    pull.className = 'secondary compact repo-pull';
    pull.textContent = 'Sync';
    pull.title = clean ? 'Run git pull --all' : 'Sync is available only when this branch has a clean working tree';
    pull.disabled = !clean;
    pull.addEventListener('click', async () => {
      if (pull.disabled) return;
      pull.disabled = true;
      pull.textContent = 'Pulling…';
      try {
        await apiJson('/api/repos/pull', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: repo.name }),
        });
        toast(`Synced ${repo.name}`);
      } catch (error) {
        if (!isAbort(error)) toast(error.message, 'error');
      } finally {
        try { await loadRepos(); }
        catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
      }
    });
    card.append(pull);
    list.append(card);
  }
}

async function loadRepos() {
  const data = await apiJson('/api/repos', {}, 'repos');
  if (state.activeFeature !== 'repos') return;
  renderRepos($('#repo-list'), data.repos || []);
}

async function loadNotes() {
  const list = $('#note-list');
  const content = $('#note-content');
  const title = $('#note-title');
  const meta = $('#note-meta');
  list.replaceChildren();
  title.textContent = 'Notes';
  meta.textContent = 'Loading Markdown notes…';
  content.textContent = 'Select a note to read it.';
  try {
    const data = await apiJson('/api/notes', {}, 'notes');
    if (state.activeFeature !== 'notes') return;
    const notes = Array.isArray(data.notes) ? data.notes : [];
    meta.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
    if (!notes.length) content.textContent = 'No notes found.';
    const root = { folders: new Map(), notes: [] };
    for (const note of notes) {
      const path = note.path || note.name || '';
      const parts = path.split('/').filter(Boolean);
      if (!parts.length) continue;
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), notes: [] });
        folder = folder.folders.get(part);
      }
      folder.notes.push({ path, name: parts.at(-1) });
    }
    const appendFolder = (folder, parent) => {
      const items = document.createElement('ul');
      items.className = 'notes-tree';
      for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
        const item = document.createElement('li');
        item.className = 'notes-tree-folder';
        const label = document.createElement('span');
        label.className = 'notes-tree-folder-label';
        label.textContent = name;
        item.append(label);
        appendFolder(child, item);
        items.append(item);
      }
      for (const note of folder.notes.sort((a, b) => a.name.localeCompare(b.name))) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-item';
        button.textContent = note.name;
        button.title = note.path;
        button.setAttribute('aria-label', `Open note ${note.path}`);
        button.addEventListener('click', async () => {
          list.querySelector('.file-item.selected')?.classList.remove('selected');
          button.classList.add('selected');
          title.textContent = note.name;
          meta.textContent = note.path;
          content.textContent = 'Loading note…';
          closeDrawer();
          try {
            const result = await apiJson(`/api/notes/content?path=${encodeURIComponent(note.path)}`, {}, 'note-content');
            if (state.activeFeature !== 'notes') return;
            content.replaceChildren();
            renderMarkdown(content, typeof result.content === 'string' ? result.content : '');
          } catch (error) {
            if (!isAbort(error)) content.textContent = `Unable to load note: ${error.message}`;
          }
        });
        item.append(button);
        items.append(item);
      }
      parent.append(items);
    };
    if (notes.length) appendFolder(root, list);
  } catch (error) {
    if (isAbort(error)) return;
    list.replaceChildren();
    title.textContent = 'Notes';
    meta.textContent = 'Unable to load Markdown notes';
    content.textContent = `Unable to load notes: ${error.message}`;
  }
}

async function loadProviderAuth(harness) {
  const panel = document.querySelector(`[data-auth-provider="${harness}"]`);
  const endpoint = `/api/${harness}/auth`;
  try {
    const { providers = [] } = await apiJson(endpoint);
    panel.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = 'OpenAI authentication';
    panel.append(title);
    const list = document.createElement('div');
    list.className = 'auth-provider-list';
    for (const id of ['openai-codex', 'openai']) {
      const configured = providers.find((item) => item.providerId === id)?.configured === true;
      const row = document.createElement('section');
      row.className = 'auth-provider-row';
      const info = document.createElement('div');
      info.className = 'auth-provider-info';
      const name = document.createElement('strong');
      name.textContent = id === 'openai-codex' ? 'ChatGPT subscription' : 'API key';
      const description = document.createElement('span');
      description.textContent = id === 'openai-codex' ? 'Sign in with your OpenAI account' : 'Use an OpenAI API key';
      info.append(name, description);
      const badge = document.createElement('span');
      badge.className = `auth-provider-status${configured ? ' connected' : ''}`;
      badge.textContent = configured ? 'Connected' : 'Not configured';
      const actions = document.createElement('div');
      actions.className = 'auth-provider-actions';
      if (id === 'openai-codex') {
        const login = document.createElement('button');
        login.type = 'button'; login.textContent = configured ? 'Sign in again' : 'Sign in';
        login.addEventListener('click', async () => {
          delete panel.dataset.oauthUrl;
          try {
            const result = await apiJson(`${endpoint}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id, type: 'oauth' }) });
            await renderAuthFlow(harness, panel, result.token);
          } catch (error) { toast(error.message, 'error'); }
        });
        actions.append(login);
      } else {
        const form = document.createElement('form');
        const input = document.createElement('input');
        input.type = 'password'; input.autocomplete = 'off'; input.placeholder = 'OpenAI API key';
        input.setAttribute('aria-label', `${harness === 'pi' ? 'Pi' : 'Friday'} OpenAI API key`);
        const save = document.createElement('button');
        save.type = 'submit'; save.textContent = configured ? 'Replace key' : 'Save key';
        form.append(input, save);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const key = input.value; input.value = '';
          if (!key) return;
          try {
            await apiJson(`${endpoint}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id, type: 'api_key', key }) });
            await loadProviderAuth(harness);
            toast('API key saved');
          } catch (error) { toast(error.message, 'error'); }
        });
        actions.append(form);
      }
      if (configured) {
        const logout = document.createElement('button');
        logout.type = 'button'; logout.className = 'auth-provider-logout'; logout.textContent = 'Log out';
        logout.setAttribute('aria-label', `Log out ${name.textContent}`);
        logout.addEventListener('click', async () => {
          try {
            await apiJson(`${endpoint}/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id }) });
            await loadProviderAuth(harness);
          } catch (error) { toast(error.message, 'error'); }
        });
        actions.append(logout);
      }
      row.append(info, badge, actions);
      list.append(row);
    }
    panel.append(list);
  } catch (error) { panel.textContent = `Authentication status unavailable: ${error.message}`; }
}

async function renderAuthFlow(harness, panel, token, current = null) {
  const endpoint = `/api/${harness}/auth/flow`;
  const data = current || await apiJson(`${endpoint}?token=${encodeURIComponent(token)}`, {}, `auth-flow-${harness}`);
  panel.replaceChildren();
  for (const value of [data.message, data.instruction, data.device_code, data.manual_code, data.userCode, data.challenge]) {
    if (value == null || value === '') continue;
    const line = document.createElement('p'); line.textContent = typeof value === 'string' ? value : JSON.stringify(value); panel.append(line);
  }
  const linkTarget = data.auth_url || data.url || data.verification_uri || data.verificationUri || data.links?.[0]?.url || panel.dataset.oauthUrl;
  const safeUrl = typeof linkTarget === 'string' ? (() => { try { const url = new URL(linkTarget); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } })() : null;
  if (safeUrl) panel.dataset.oauthUrl = safeUrl;
  if (safeUrl) { const link = document.createElement('a'); link.href = safeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open authorization page'; panel.append(link); }
  if (data.complete || data.authenticated) { await loadProviderAuth(harness); toast('Provider authenticated'); return; }
  const form = document.createElement('form');
  const needsResponse = data.type === 'prompt' || data.requires_response === true || data.requiresResponse === true || Boolean(data.challenge && !data.pending);
  if (needsResponse) {
    const response = document.createElement(data.inputType === 'select' || data.options?.length ? 'select' : 'input');
    if (response.tagName === 'SELECT') {
      for (const item of data.options || []) {
        const option = document.createElement('option'); option.value = item.id; option.textContent = item.label || item.id; response.append(option);
      }
    } else {
      response.autocomplete = 'off'; response.placeholder = data.placeholder || 'Paste authorization code or redirect URL';
    }
    response.setAttribute('aria-label', data.message || 'Challenge response');
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Submit response'; form.append(response, submit);
    form.addEventListener('submit', async (event) => { event.preventDefault(); const answer = response.value; response.value = ''; if (!answer) return;
      try { const next = await apiJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, response: answer }) });
        if (next.complete || next.authenticated) { await loadProviderAuth(harness); toast('Provider authenticated'); }
        else await renderAuthFlow(harness, panel, token);
      } catch (error) { toast(error.message, 'error'); }
    });
  }
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel sign-in';
  cancel.addEventListener('click', () => { cancelRequest(`auth-flow-${harness}`); void apiJson(`${endpoint}?token=${encodeURIComponent(token)}`, { method: 'DELETE' }).finally(() => loadProviderAuth(harness)); });
  form.append(cancel);
  panel.append(form);
  const poll = async () => {
    if (!panel.contains(form)) return;
    try {
      const next = await apiJson(`${endpoint}?token=${encodeURIComponent(token)}`, {}, `auth-flow-${harness}`);
      if (!panel.contains(form)) return;
      if (next.pending) setTimeout(poll, 2000);
      else await renderAuthFlow(harness, panel, token, next);
    } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
  };
  setTimeout(poll, 2000);
}

async function loadSyncSettings(scope) {
  const panel = document.querySelector(`[data-sync="${scope}"]`);
  try {
    const data = await apiJson(`/api/${scope}/sync/settings`);
    const form = panel.querySelector('form');
    form.elements.owner.value = data.owner || '';
    form.elements.repo.value = data.repo || '';
    const status = panel.querySelector('.sync-status');
    status.textContent = [data.status, data.lastSync ? `Last sync: ${formatLocalTimestamp(data.lastSync)}` : '', data.error ? `Error: ${data.error}` : ''].filter(Boolean).join(' · ') || 'Not synced yet';
  } catch (error) { panel.querySelector('.sync-status').textContent = `Unavailable: ${error.message}`; }
}

for (const panel of document.querySelectorAll('[data-sync]')) {
  const scope = panel.dataset.sync;
  const form = panel.querySelector('form');
  const save = form.querySelector('[type="submit"]');
  const run = panel.querySelector('[data-sync-run]');
  const submit = async (endpoint, body) => {
    if (panel.dataset.busy) return;
    panel.dataset.busy = 'true'; save.disabled = run.disabled = true;
    try {
      const data = await apiJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      await loadSyncSettings(scope);
      if (data.error) throw new Error(data.error);
      if (endpoint.endsWith('/run')) panel.querySelector('.sync-status').textContent = `${data.pushed ? `Pushed ${data.copied} files` : 'Already up to date'} · Last sync: ${formatLocalTimestamp(data.lastSync)}`;
    } catch (error) { panel.querySelector('.sync-status').textContent = `Error: ${error.message}`; }
    finally { delete panel.dataset.busy; save.disabled = run.disabled = false; }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); void submit(`/api/${scope}/sync/settings`, { owner: form.elements.owner.value.trim(), repo: form.elements.repo.value.trim() }); });
  run.addEventListener('click', () => void submit(`/api/${scope}/sync/run`));
}

const financeValues = new WeakMap();
const visibleFinanceValues = new WeakSet();

function setFinanceValue(element, value) {
  const visible = visibleFinanceValues.has(element);
  element.classList.add('financial-sensitive');
  financeValues.set(element, String(value));
  element.classList.toggle('is-censored', !visible);
  element.textContent = visible ? String(value) : '••••••';
  element.setAttribute('aria-hidden', String(!visible));
  return element;
}

function updateFinanceVisibility(targets, button, label) {
  const elements = Array.isArray(targets) ? targets : [targets];
  if (!elements.length || elements.some((element) => !financeValues.has(element))) return;
  const visible = !elements.every((element) => visibleFinanceValues.has(element));
  for (const element of elements) {
    if (visible) visibleFinanceValues.add(element);
    else visibleFinanceValues.delete(element);
    setFinanceValue(element, financeValues.get(element));
  }
  const accessibleLabel = `${visible ? 'Hide' : 'Show'} ${label}`;
  button.setAttribute('aria-label', accessibleLabel);
  button.title = accessibleLabel;
  button.setAttribute('aria-pressed', String(visible));
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-finance-visibility][data-finance-target]');
  if (!button) return;
  const element = document.getElementById(button.dataset.financeTarget);
  if (element) updateFinanceVisibility(element, button, button.dataset.financeLabel);
});

function createFinanceVisibilityButton(element, label, compact = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `finance-visibility-toggle${compact ? ' finance-visibility-compact' : ''}`;
  button.dataset.financeVisibility = '';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  button.setAttribute('aria-label', `Show ${label}`);
  button.setAttribute('aria-pressed', 'false');
  button.title = `Show ${label}`;
  button.addEventListener('click', () => updateFinanceVisibility(element, button, label));
  return button;
}

function renderDashboardCard(label, value, detail = '') {
  const card = document.createElement('article'); card.className = 'dashboard-metric';
  const title = document.createElement('span'); title.className = 'dashboard-metric-label'; title.textContent = label;
  const main = document.createElement('strong'); main.className = 'dashboard-metric-value'; main.textContent = value;
  card.append(title, main);
  if (detail) { const note = document.createElement('span'); note.className = 'dashboard-metric-detail'; note.textContent = detail; card.append(note); }
  return card;
}

function renderMemoryGraphCard(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const card = document.createElement('section'); card.className = 'dashboard-panel dashboard-memory-card';
  const heading = document.createElement('h2'); heading.className = 'dashboard-panel-heading'; heading.textContent = 'Memory graph';
  const summary = document.createElement('p'); summary.textContent = graph ? `${nodes.length} notes · ${graph.totalDailyNotes || 0} daily · ${edges.length} links${graph.truncated ? ' · recent 40 shown' : ''}` : 'Unavailable';
  card.append(heading, summary);
  if (graph) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 320 150'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Memory graph with ${nodes.length} notes and ${edges.length} links`);
    const byId = new Map(nodes.map((node, index) => {
      const angle = -Math.PI / 2 + 2 * Math.PI * index / Math.max(nodes.length, 1);
      const radius = nodes.length < 2 ? 0 : Math.min(57, 16 + nodes.length * 1.1);
      return [node.id, { ...node, x: 160 + Math.cos(angle) * radius, y: 73 + Math.sin(angle) * radius }];
    }));
    for (const edge of edges) {
      const from = byId.get(edge.source); const to = byId.get(edge.target);
      if (!from || !to) continue;
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', from.x); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x); line.setAttribute('y2', to.y); line.classList.add('memory-graph-edge'); svg.append(line);
    }
    for (const node of byId.values()) {
      const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('cx', node.x); circle.setAttribute('cy', node.y); circle.setAttribute('r', node.type === 'curated' ? 7 : 4.5); circle.classList.add('memory-graph-node', node.type === 'curated' ? 'curated' : 'daily');
      const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = node.label; circle.append(title); svg.append(circle);
    }
    if (!nodes.length) { const empty = document.createElementNS(svg.namespaceURI, 'text'); empty.setAttribute('x', '160'); empty.setAttribute('y', '78'); empty.setAttribute('text-anchor', 'middle'); empty.textContent = 'No memory notes yet'; svg.append(empty); }
    card.append(svg);
  }
  const review = document.createElement('button'); review.type = 'button'; review.className = 'memory-graph-review'; review.textContent = 'Browse memory';
  review.addEventListener('click', () => { state.fileFeature = 'files'; state.files.files.path = 'memory'; void setFeature('files'); });
  card.append(review);
  return card;
}

let dashboardLoadSequence = 0;
let dashboardClockTimer;
let dashboardTemperatureTimer;
let dashboardStatusTimer;
let dashboardStatusRequest = 0;
const dashboardStatusRefreshInterval = 3_000;
function renderDashboardTemperature(data) {
  const output = $('#dashboard-temperature');
  if (!output) return;
  if (data?.status === 'available' && Number.isFinite(data.celsius)) {
    output.textContent = `Highest sensor: ${data.celsius.toFixed(1)} °C`;
  } else {
    const status = data?.status === 'unsupported' ? 'Unsupported on this host'
      : data?.status === 'permission-denied' ? 'Sensor access restricted'
        : 'Unavailable';
    output.textContent = `Temperature: ${status}`;
  }
}
function scheduleDashboardTemperatureRefresh() {
  clearTimeout(dashboardTemperatureTimer);
  dashboardTemperatureTimer = setTimeout(async () => {
    if (state.activeFeature !== 'dashboard') return;
    try {
      const temperature = await apiJson('/api/system/temperature');
      if (state.activeFeature !== 'dashboard') return;
      renderDashboardTemperature(temperature);
    } catch {
      if (state.activeFeature !== 'dashboard') return;
      renderDashboardTemperature(null);
    }
    scheduleDashboardTemperatureRefresh();
  }, 60_000);
}
function updateDashboardAgentStatus(key, data) {
  const status = document.querySelector(`[data-dashboard-agent-status="${key}"]`);
  if (!status || !data) return;
  status.textContent = data.busy ? 'Working'
    : (key === 'friday' ? data.running : data.piRunning) === false ? 'Standby' : 'Ready';
}
function scheduleDashboardStatusRefresh() {
  clearTimeout(dashboardStatusTimer);
  dashboardStatusTimer = setTimeout(async () => {
    if (state.activeFeature !== 'dashboard') return;
    const request = ++dashboardStatusRequest;
    try {
      const results = await Promise.allSettled([
        apiJson('/api/friday/status'), apiJson('/api/status'),
      ]);
      if (request !== dashboardStatusRequest || state.activeFeature !== 'dashboard') return;
      const [friday, pi] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
      updateDashboardAgentStatus('friday', friday);
      updateDashboardAgentStatus('pi', pi);
      const activeAgents = document.querySelector('[data-dashboard-active-agents]');
      const activeAgentsDetail = document.querySelector('[data-dashboard-active-agents-detail]');
      if (activeAgents && friday && pi) {
        activeAgents.textContent = String(Number(friday.running === true) + Number(pi.piRunning === true));
        activeAgentsDetail.textContent = `Friday ${Number(friday.running === true)} running · Pi ${Number(pi.piRunning === true)} running`;
      }
    } catch {}
    if (request === dashboardStatusRequest && state.activeFeature === 'dashboard') scheduleDashboardStatusRefresh();
  }, dashboardStatusRefreshInterval);
}
async function loadDashboard() {
  clearTimeout(dashboardTemperatureTimer);
  clearTimeout(dashboardStatusTimer);
  dashboardStatusRequest += 1;
  const sequence = ++dashboardLoadSequence;
  const cards = $('#dashboard-cards');
  const results = await Promise.allSettled([
    apiJson('/api/friday/status'), apiJson('/api/status'), apiJson('/api/system/settings'), apiJson('/api/system/temperature'), apiJson('/api/devices'), apiJson('/api/friday/memory/graph'), apiJson('/api/finances'),
  ]);
  if (sequence !== dashboardLoadSequence || state.activeFeature !== 'dashboard') return;
  const [friday, pi, system, temperature, devices, memoryGraph, finances] = results.map((result) => result.status === 'fulfilled' ? result.value : null);
  const hostName = devices?.devices?.find((device) => device.self)?.hostname || devices?.devices?.find((device) => device.local)?.hostname;
  const page = document.createElement('div'); page.className = 'dashboard-content';
  const header = $('#dashboard-feature .page-header');
  const now = new Date();
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
  header.querySelector('.eyebrow').textContent = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  header.querySelector('h1').textContent = 'Dashboard';
  header.querySelector('p').textContent = 'Your workspace at a glance.';
  const hero = document.createElement('section'); hero.className = 'dashboard-hero';
  const copy = document.createElement('div'); copy.className = 'dashboard-hero-copy';
  const title = document.createElement('h2'); title.textContent = `${greeting}, Cornelius.`;
  const clock = document.createElement('time'); clock.className = 'dashboard-clock';
  const clockTime = document.createElement('span');
  const clockSeconds = document.createElement('span'); clockSeconds.className = 'dashboard-clock-seconds';
  clock.append(clockTime, clockSeconds);
  const updateClock = () => { const time = new Date(); clock.dateTime = time.toISOString(); clockTime.textContent = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); clockSeconds.textContent = String(time.getSeconds()).padStart(2, '0'); }; 
  clearInterval(dashboardClockTimer); updateClock(); dashboardClockTimer = setInterval(updateClock, 1000);
  const actions = document.createElement('div'); actions.className = 'dashboard-actions';
  for (const [label, feature] of [['Ask Friday', 'friday'], ['Pi workspace', 'pi']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', () => { if (feature === 'friday') workspaceShell.openAssistant(); else void setFeature(feature); }); actions.append(button);
  }
  copy.append(title, clock, actions);
  const orbit = document.createElement('div'); orbit.className = 'dashboard-orbit'; orbit.setAttribute('aria-hidden', 'true'); orbit.innerHTML = '<svg viewBox="0 0 240 240"><defs><radialGradient id="dashboard-orb"><stop stop-color="#72d9e5" stop-opacity=".15"/><stop offset="1" stop-color="#72d9e5" stop-opacity="0"/></radialGradient></defs><circle cx="120" cy="120" r="104" fill="url(#dashboard-orb)"/><g fill="none" stroke="currentColor"><circle cx="120" cy="120" r="94" stroke-opacity=".1"/><g class="orbit-rotate"><circle cx="120" cy="120" r="85" stroke-opacity=".3" stroke-dasharray="1 8"/><path d="M120 25a95 95 0 0 1 95 95M120 215a95 95 0 0 1-95-95" stroke-opacity=".55"/><circle cx="120" cy="25" r="3" fill="currentColor" stroke="none"/></g><g class="orbit-rotate orbit-reverse"><circle cx="120" cy="120" r="66" stroke-opacity=".35" stroke-dasharray="70 14 5 14"/><path d="m120 51 60 34v70l-60 34-60-34V85Z" stroke-opacity=".13"/></g><circle cx="120" cy="120" r="49" stroke-opacity=".2"/><path d="M120 65v15m0 80v15M65 120h15m80 0h15" stroke-opacity=".55"/></g><g class="orbit-breathe" fill="none" stroke="currentColor"><path d="m120 92 7.5 20.5L148 120l-20.5 7.5L120 148l-7.5-20.5L92 120l20.5-7.5Z" stroke-width="1.4"/><circle cx="120" cy="120" r="5" fill="currentColor" opacity=".4"/></g></svg>';
  hero.append(copy, orbit);
  const metrics = document.createElement('section'); metrics.className = 'dashboard-metrics';
  const metricItems = [
    ['Active agents', friday && pi ? String(Number(friday.running === true) + Number(pi.piRunning === true)) : 'Unavailable', `Friday ${friday ? `${Number(friday.running === true)} running` : 'unavailable'} · Pi ${pi ? `${Number(pi.piRunning === true)} running` : 'unavailable'}`],
    ['Host CPU', formatPercent(system?.systemUsage?.cpuPercent), hostName || 'CPU usage'],
    ['Monthly expenses', finances && Array.isArray(finances.entries) ? money(finances.entries.filter((entry) => entry.type === 'expense' && entry.date >= financeSummaryRange(1).start && entry.date <= financeSummaryRange(1).end).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0)) : 'Unavailable', 'Past month · IDR'],
    ['Memory notes', memoryGraph ? String(memoryGraph.nodes?.length || 0) : 'Unavailable', 'Friday memory'],
  ];
  for (const item of metricItems) {
    const card = renderDashboardCard(...item);
    if (item[0] === 'Active agents') {
      card.querySelector('.dashboard-metric-value').dataset.dashboardActiveAgents = '';
      card.querySelector('.dashboard-metric-detail').dataset.dashboardActiveAgentsDetail = '';
    }
    if (item[0] === 'Monthly expenses' && item[1] !== 'Unavailable') {
      const value = setFinanceValue(card.querySelector('.dashboard-metric-value'), item[1]);
      const row = document.createElement('div'); row.className = 'dashboard-metric-value-row';
      row.append(value, createFinanceVisibilityButton(value, 'monthly expenses', true));
      const detail = card.querySelector('.dashboard-metric-detail');
      card.insertBefore(row, detail);
    }
    metrics.append(card);
  }
  const columns = document.createElement('div'); columns.className = 'dashboard-columns';
  const agents = document.createElement('section'); agents.className = 'dashboard-panel';
  const agentsHeading = document.createElement('h2'); agentsHeading.className = 'dashboard-panel-heading'; agentsHeading.textContent = 'Your agents'; agents.append(agentsHeading);
  for (const [label, data, model, usage, feature] of [['Friday', friday, friday?.model?.name || friday?.model?.id || 'Model unavailable', friday?.contextUsage, 'friday'], ['Pi', pi, pi?.workspace || 'Workspace unavailable', pi?.contextUsage, 'pi']]) {
    const row = document.createElement('div'); row.className = 'dashboard-agent-row';
    const avatar = document.createElement('span'); avatar.className = 'dashboard-agent-avatar'; avatar.textContent = label === 'Friday' ? 'F' : 'π';
    const name = document.createElement('strong'); name.textContent = label;
    const stateText = document.createElement('span'); stateText.className = 'dashboard-status'; stateText.dataset.dashboardAgentStatus = label.toLowerCase(); stateText.textContent = !data ? 'Unavailable' : data.busy ? 'Working' : (label === 'Friday' ? data.running : data.piRunning) === false ? 'Standby' : 'Ready';
    const info = document.createElement('small'); info.textContent = model;
    const pct = Number.isFinite(usage?.percent) ? usage.percent : Number.isFinite(usage?.tokens) && usage.contextWindow ? usage.tokens / usage.contextWindow * 100 : null;
    const progress = document.createElement('progress'); progress.max = 100; progress.value = pct === null ? 0 : Math.max(0, Math.min(100, pct)); progress.setAttribute('aria-label', `${label} context usage`); progress.setAttribute('aria-valuetext', pct === null ? 'Unavailable' : `${pct.toFixed(1)} percent`);
    const context = document.createElement('small'); context.textContent = pct === null ? 'Context unavailable' : `${pct.toFixed(1)}% context used`;
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open chat'; open.setAttribute('aria-label', `Open ${label} chat`); open.addEventListener('click', () => void setFeature(feature));
    row.append(avatar, name, stateText, info, progress, context, open); agents.append(row);
  }
  const resources = document.createElement('section'); resources.className = 'dashboard-panel';
  const resourceHeading = document.createElement('h2'); resourceHeading.className = 'dashboard-panel-heading'; resourceHeading.textContent = 'Host resources'; resources.append(resourceHeading);
  const resourceDetail = document.createElement('p'); resourceDetail.textContent = `${devices ? `${(devices.devices || []).length} visible devices` : 'Device count unavailable'} · ${hostName ? `Host: ${hostName}` : 'Host unavailable'}`; resources.append(resourceDetail);
  for (const [label, value] of [['CPU', system?.systemUsage?.cpuPercent], ['RAM', system?.systemUsage?.memoryPercent]]) {
    const wrap = document.createElement('div'); wrap.className = 'dashboard-resource-gauge'; const text = document.createElement('label'); text.textContent = `${label}: ${formatPercent(value)}`; const gauge = document.createElement('progress'); gauge.max = 100; gauge.value = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0; gauge.setAttribute('aria-label', `${label} usage`); gauge.setAttribute('aria-valuetext', formatPercent(value)); wrap.append(text, gauge); resources.append(wrap);
  }
  const temperatureWrap = document.createElement('div'); temperatureWrap.className = 'dashboard-resource-gauge';
  const temperatureText = document.createElement('span'); temperatureText.className = 'dashboard-resource-temperature'; temperatureText.setAttribute('aria-live', 'polite'); temperatureText.id = 'dashboard-temperature';
  temperatureWrap.append(temperatureText); resources.append(temperatureWrap);
  const memory = renderMemoryGraphCard(memoryGraph);
  const finance = document.createElement('section'); finance.className = 'dashboard-panel dashboard-finance';
  const dashboardFinanceValues = [];
  const financeHeading = document.createElement('h2'); financeHeading.className = 'dashboard-panel-heading'; financeHeading.textContent = 'Financial snapshot';
  const financeVisibility = createFinanceVisibilityButton(dashboardFinanceValues, 'financial snapshot'); financeVisibility.hidden = true;
  financeHeading.append(financeVisibility); finance.append(financeHeading);
  if (finances && Array.isArray(finances.entries)) {
    const range = financeSummaryRange(1); const entries = finances.entries.filter((entry) => entry.date >= range.start && entry.date <= range.end);
    const totals = entries.reduce((sum, entry) => { if (entry.type === 'expense') sum.expense += Number(entry.amount) || 0; else sum.income += Number(entry.amount) || 0; return sum; }, { income: 0, expense: 0 });
    const balance = setFinanceValue(document.createElement('strong'), money(totals.income - totals.expense)); dashboardFinanceValues.push(balance);
    const balanceRow = document.createElement('div'); balanceRow.className = 'dashboard-finance-value'; balanceRow.append(balance); finance.append(balanceRow);
    const detail = document.createElement('p');
    const income = setFinanceValue(document.createElement('span'), money(totals.income)); dashboardFinanceValues.push(income);
    const expenses = setFinanceValue(document.createElement('span'), money(totals.expense)); dashboardFinanceValues.push(expenses);
    financeVisibility.hidden = false;
    detail.append(`${range.start} – ${range.end} · Income `, income, ' · Expenses ', expenses);
    finance.append(detail);
    if (entries.length) {
      const daily = new Map();
      for (const entry of entries) daily.set(entry.date, (daily.get(entry.date) || 0) + (entry.type === 'income' ? entry.amount : -entry.amount));
      let balance = 0;
      const points = [0, ...[...daily].sort(([a], [b]) => a.localeCompare(b)).map(([, change]) => balance += change)];
      const min = Math.min(...points), max = Math.max(...points);
      const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chart.classList.add('dashboard-finance-chart'); chart.hidden = true; chart.setAttribute('viewBox', '0 0 300 95'); chart.setAttribute('preserveAspectRatio', 'none'); chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', 'Cumulative net income and expenses for the past month');
      financeVisibility.addEventListener('click', () => { chart.hidden = financeVisibility.getAttribute('aria-pressed') !== 'true'; });
      const line = document.createElementNS(chart.namespaceURI, 'polyline');
      line.setAttribute('points', points.map((value, i) => `${i / (points.length - 1) * 300},${80 - (value - min) / (max - min || 1) * 65}`).join(' '));
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'var(--accent)'); line.setAttribute('stroke-width', '1.8'); line.setAttribute('vector-effect', 'non-scaling-stroke'); chart.append(line); finance.append(chart);
    }
    const openFinance = document.createElement('button'); openFinance.type = 'button'; openFinance.className = 'memory-graph-review'; openFinance.textContent = 'View transactions →'; openFinance.addEventListener('click', () => void setFeature('finances')); finance.append(openFinance);
  } else { const unavailable = document.createElement('p'); unavailable.textContent = 'Financial data unavailable'; finance.append(unavailable); }
  const left = document.createElement('div'); left.className = 'dashboard-stack'; left.append(agents, memory);
  const right = document.createElement('div'); right.className = 'dashboard-stack'; right.append(finance, resources);
  columns.append(left, right);
  const footer = document.createElement('footer'); footer.className = 'dashboard-footer'; footer.innerHTML = '<span>FRIDAY OS / A SPACE FOR YOUR MIND.</span><span>LOCAL-FIRST · HUMAN-CENTERED</span>';
  page.append(hero, metrics, columns, footer);
  cards.replaceChildren(page);
  renderDashboardTemperature(temperature);
  scheduleDashboardTemperatureRefresh();
  scheduleDashboardStatusRefresh();
}

async function loadSettings() {
  const [friday, pi, system, piUpdateStatus] = await Promise.all([
    apiJson('/api/friday/settings', {}, 'settings-friday'),
    apiJson('/api/pi/settings', {}, 'settings-pi'),
    apiJson('/api/system/settings', {}, 'settings-system'),
    apiJson('/api/pi/update-status', {}, 'settings-pi-update-status'),
  ]);
  if (state.activeFeature !== 'settings') return;
  renderSettings({ ...pi, fridayChat: friday.fridayChat, ...system, piUpdateStatus });
  await Promise.all([
    loadProviderAuth('friday'), loadProviderAuth('pi'),
    loadSyncSettings('friday'),
  ]);

  const githubStatus = $('#github-cli-status');
  const deviceStatus = elements.deviceStatus;
  githubStatus.textContent = 'Checking GitHub CLI…';
  deviceStatus.className = 'feature-notice';
  deviceStatus.textContent = 'Loading connected devices…';
  elements.deviceList.replaceChildren();
  const devicesRequest = apiJson('/api/devices', {}, 'devices').then((devices) => {
    if (state.activeFeature === 'settings' || state.activeFeature === 'dashboard') renderDevices(devices);
  }).catch((error) => {
    if (state.activeFeature !== 'settings' || isAbort(error)) return;
    deviceStatus.className = 'feature-notice warning';
    deviceStatus.textContent = `Could not load devices: ${error.message}`;
  });
  const githubRequest = apiJson('/api/system/github').then((github) => {
    if (state.activeFeature === 'settings') githubStatus.textContent = `Available: ${github.available ? 'Yes' : 'No'} · Authenticated: ${github.authenticated ? 'Yes' : 'No'}`;
  }).catch((error) => {
    if (state.activeFeature === 'settings' && !isAbort(error)) githubStatus.textContent = `Status unavailable: ${error.message}`;
  });
  await Promise.all([devicesRequest, githubRequest]);
}

const fridayChat = fridayChatModule
  ? fridayChatModule.createFridayChat({ apiJson, renderMarkdown, toast, onHistory: () => {
      void refreshFridayAgentViewData().catch((error) => toast(error.message, 'error'));
    }, onEnter: refreshFridayAgentViewData })
  : {
      start() { $('#friday-status').textContent = 'Restart Friday server to enable chat'; },
      stop() {},
      pause() {},
      enterView() { return Promise.resolve(); },
    };

const money = (rupiah) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(rupiah);
let editingFinanceId = null;
let financeEntries = [];

function currentFinanceMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentFinanceDate() {
  const now = new Date();
  return `${currentFinanceMonth()}-${String(now.getDate()).padStart(2, '0')}`;
}

function financeSummaryRange(months) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  start.setMonth(start.getMonth() - months);
  start.setDate(Math.min(now.getDate(), new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()));
  const dateString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { start: dateString(start), end: dateString(now) };
}

function updateFinanceSummary() {
  const range = financeSummaryRange(Number(elements.financeSummaryPeriod.value) || 1);
  const totals = financeEntries
    .filter((entry) => entry.date >= range.start && entry.date <= range.end)
    .reduce((result, entry) => {
      result[entry.type] += entry.amount;
      return result;
    }, { income: 0, expense: 0 });
  setFinanceValue(elements.financeIncome, money(totals.income));
  setFinanceValue(elements.financeExpenses, money(totals.expense));
  setFinanceValue(elements.financeBalance, money(totals.income - totals.expense));
}

function visibleFinanceEntries() {
  return financeEntries.filter((entry) => (
    (!elements.financeMonth.value || entry.date.startsWith(elements.financeMonth.value))
    && (elements.financeTypeFilter.value === 'all' || entry.type === elements.financeTypeFilter.value)
    && (elements.financeCategoryFilter.value === 'all' || entry.category === elements.financeCategoryFilter.value)
  ));
}

function resetFinanceForm() {
  editingFinanceId = null;
  elements.financeForm.reset();
  elements.financeForm.elements.date.value = currentFinanceDate();
  elements.financeSubmit.textContent = 'Add entry';
  elements.financeCancel.hidden = true;
}

function editFinance(entry) {
  editingFinanceId = entry.id;
  for (const field of ['type', 'amount', 'date', 'category', 'description']) {
    if (field === 'amount') elements.financeForm.elements[field].value = String(entry.amount);
    else elements.financeForm.elements[field].value = entry[field];
  }
  elements.financeSubmit.textContent = 'Save changes';
  elements.financeCancel.hidden = false;
  elements.financeForm.elements.amount.focus();
}

async function loadFinances() {
  const { entries } = await apiJson('/api/finances', {}, 'finances');
  financeEntries = entries;
  updateFinanceSummary();
  elements.financeList.replaceChildren();
  const visibleEntries = visibleFinanceEntries();
  if (!financeEntries.length) {
    elements.financeStatus.textContent = 'No transactions yet. Add your first transaction above.';
    return;
  }
  if (!visibleEntries.length) {
    elements.financeStatus.textContent = 'No transactions match these filters.';
    return;
  }
  elements.financeStatus.textContent = '';
  for (const entry of visibleEntries) {
    const row = document.createElement('article');
    row.className = 'finance-entry';
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = entry.description || entry.category;
    const meta = document.createElement('span');
    meta.textContent = `${entry.category} · ${entry.date}`;
    details.append(title, meta);
    const amount = document.createElement('strong');
    amount.className = entry.type;
    amount.textContent = `${entry.type === 'expense' ? '-' : '+'}${money(entry.amount)}`;
    const actions = document.createElement('div');
    actions.className = 'finance-actions';
    const edit = document.createElement('button');
    edit.className = 'text-button'; edit.type = 'button'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => editFinance(entry));
    const remove = document.createElement('button');
    remove.className = 'text-button'; remove.type = 'button'; remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete transaction “${entry.description || entry.category}”?`)) return;
      try { await apiJson(`/api/finances/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }); await loadFinances(); }
      catch (error) { toast(error.message, 'error'); }
    });
    actions.append(edit, remove);
    row.append(details, amount, actions);
    elements.financeList.append(row);
  }
}

function exportFinanceCsv() {
  const escape = (value) => {
    const text = String(value);
    const safe = /^\s*[=+@-]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rows = [['Date', 'Type', 'Category', 'Description', 'Amount'], ...visibleFinanceEntries().map((entry) => [
    entry.date, entry.type, entry.category, entry.description, String(entry.amount),
  ])];
  const csv = rows.map((row) => row.map(escape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `friday-transactions-${elements.financeMonth.value || 'all'}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function addFinance(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    const endpoint = editingFinanceId ? `/api/finances/${encodeURIComponent(editingFinanceId)}` : '/api/finances';
    await apiJson(endpoint, { method: editingFinanceId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    resetFinanceForm();
    await loadFinances();
  } catch (error) { toast(error.message, 'error'); }
}

function initializeWorkspaceShell({ navigate, getFeature }) {
  const shell = $('.workspace-shell');
  const sidebar = $('#workspace-sidebar');
  const assistant = $('#assistant-rail');
  const chat = $('.friday-app');
  const chatHome = document.createComment('Friday chat mount');
  chat.before(chatHome);
  const backdrop = $('#shell-backdrop');
  const dialog = $('#shell-command-dialog');
  const commandInput = $('#shell-command-input');
  const commandResults = dialog.querySelector('.command-results');
  let drawer = null;
  let returnFocus = null;
  let assistantExpanded = false;
  const narrowSidebar = matchMedia('(max-width: 600px)');
  const narrowAssistant = matchMedia('(max-width: 1170px)');
  const isDrawer = (element) => element === sidebar ? narrowSidebar.matches : narrowAssistant.matches;
  const focusable = (element) => [...element.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')]
    .filter((item) => item.getClientRects().length && !item.closest('[inert]'));
  function sync() {
    const chatFeature = ['friday', 'pi'].includes(getFeature());
    assistant.hidden = chatFeature || (!narrowAssistant.matches && !assistantExpanded);
    shell.dataset.assistant = assistantExpanded ? 'open' : 'closed';
    for (const button of document.querySelectorAll('[data-shell-drawer="assistant"]')) button.hidden = chatFeature;
    for (const element of [sidebar, assistant]) {
      const closed = isDrawer(element) && drawer !== element;
      element.inert = closed || (element === assistant && (chatFeature || assistant.hidden));
      if (element.inert) element.setAttribute('aria-hidden', 'true');
      else element.removeAttribute('aria-hidden');
    }
    // Off-canvas surfaces are modal; background controls must not receive focus.
    $('#main-content').inert = !!drawer;
    $('.workspace-topbar').inert = !!drawer;
    $('.shell-mobile-shortcuts').inert = !!drawer;
    if (drawer && drawer !== sidebar) sidebar.inert = true;
    if (drawer && drawer !== assistant) assistant.inert = true;
    for (const button of document.querySelectorAll('[data-shell-drawer]')) {
      const target = button.dataset.shellDrawer === 'sidebar' ? sidebar : assistant;
      const expanded = target === assistant && !chatFeature
        ? narrowAssistant.matches ? drawer === assistant : assistantExpanded
        : drawer === target;
      button.setAttribute('aria-expanded', String(expanded));
      if (target === assistant) button.setAttribute('aria-label', `${expanded ? 'Close' : 'Open'} Friday assistant`);
    }
  }
  function close(restore = true) {
    if (!drawer) {
      if (!narrowAssistant.matches && assistantExpanded) {
        assistantExpanded = false;
        sync();
        if (restore) document.querySelector('[data-shell-drawer="assistant"]:not([hidden])')?.focus();
      }
      return;
    }
    drawer.classList.remove('shell-drawer-open');
    drawer.removeAttribute('role');
    drawer.removeAttribute('aria-modal');
    drawer = null;
    backdrop.hidden = true;
    sync();
    if (restore && returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus();
    returnFocus = null;
  }
  function open(element, trigger = document.activeElement) {
    if (element === assistant && ['friday', 'pi'].includes(getFeature())) {
      $(getFeature() === 'friday' ? '#friday-message' : '#message').focus();
      return;
    }
    if (!isDrawer(element)) {
      if (element === assistant) {
        assistantExpanded = true;
        sync();
        $('#friday-message').focus();
      } else focusable(sidebar)[0]?.focus();
      return;
    }
    close(false);
    closeDrawer();
    returnFocus = trigger;
    drawer = element;
    element.classList.add('shell-drawer-open');
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    backdrop.hidden = false;
    sync();
    (element === assistant ? $('#friday-message') : focusable(element)[0])?.focus();
  }
  for (const button of document.querySelectorAll('[data-navigate]')) {
    button.addEventListener('click', () => { close(false); void navigate(button.dataset.navigate); });
  }
  for (const button of document.querySelectorAll('[data-shell-drawer]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.shellDrawer === 'sidebar' ? sidebar : assistant;
      if (target === assistant && !isDrawer(assistant) && !['friday', 'pi'].includes(getFeature())) {
        assistantExpanded = !assistantExpanded;
        sync();
        if (assistantExpanded) $('#friday-message').focus(); else button.focus();
      } else open(target, button);
    });
  }
  for (const button of document.querySelectorAll('[data-shell-close]')) button.addEventListener('click', () => close());
  backdrop.addEventListener('click', () => close());
  document.addEventListener('friday:drawer-open', () => close(false));
  const commands = featureButtons.map((button) => ({ feature: button.dataset.feature, label: button.textContent.trim(), icon: button.querySelector('svg')?.cloneNode(true) }));
  function renderCommands() {
    commandResults.replaceChildren();
    for (const command of commands.filter((item) => `${item.label} ${item.feature}`.toLowerCase().includes(commandInput.value.trim().toLowerCase()))) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.commandFeature = command.feature;
      if (command.icon) button.append(command.icon.cloneNode(true));
      const label = document.createElement('span'); label.textContent = command.label;
      const hint = document.createElement('small'); hint.textContent = 'GO TO ↗';
      button.append(label, hint);
      button.addEventListener('click', () => { dialog.close(); void navigate(command.feature); });
      commandResults.append(button);
    }
    $('#command-empty').hidden = commandResults.children.length > 0;
  }
  function openCommands() {
    close(); closeDrawer();
    commandInput.value = ''; renderCommands();
    if (!dialog.open) dialog.showModal();
    commandInput.focus();
  }
  $('#shell-command-trigger').addEventListener('click', openCommands);
  $('#command-close').addEventListener('click', () => dialog.close());
  commandInput.addEventListener('input', renderCommands);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (dialog.open) dialog.close(); else openCommands();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j' && !dialog.open) {
      event.preventDefault();
      if (drawer === assistant) close();
      else if (!isDrawer(assistant) && !['friday', 'pi'].includes(getFeature())) {
        assistantExpanded = !assistantExpanded;
        sync();
        if (assistantExpanded) $('#friday-message').focus();
      } else open(assistant);
    } else if (event.key === 'Escape' && !dialog.open) close();
    if (dialog.open) {
      const buttons = [...commandResults.children];
      const current = buttons.indexOf(document.activeElement);
      if (buttons.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : current <= 0 ? buttons.length - 1 : current - 1;
        buttons[next].focus();
      } else if (event.key === 'Enter' && document.activeElement === commandInput) {
        event.preventDefault(); buttons[0]?.click();
      }
    } else if (drawer && event.key === 'Tab') {
      const items = focusable(drawer);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    }
  });
  for (const query of [narrowSidebar, narrowAssistant]) query.addEventListener('change', () => { close(false); sync(); });
  return {
    openAssistant() { open(assistant); void fridayChat.enterView().catch((error) => toast(error.message, 'error')); },
    closeNavigation() { if (drawer === sidebar) close(); },
    updateFeature(name) {
      close(false);
      shell.dataset.feature = name;
      const focusedChat = chat.contains(document.activeElement) ? document.activeElement : null;
      const scroll = $('#friday-messages').scrollTop;
      if (name === 'friday' && chat.parentElement !== chatHome.parentElement) chatHome.after(chat);
      else if (name !== 'friday' && chat.parentElement !== assistant) assistant.append(chat);
      sync();
      $('#friday-messages').scrollTop = scroll;
      if (focusedChat && !focusedChat.closest('[inert]')) focusedChat.focus({ preventScroll: true });
      for (const button of document.querySelectorAll('[data-shell-shortcut]')) {
        const active = button.dataset.navigate === name;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      }
    },
  };
}

function updateTopbar(name = state.activeFeature) {
  const labels = { dashboard: 'Dashboard', friday: 'Friday Agent', pi: 'Pi Agent', notes: 'Notes', finances: 'Finances', socials: 'Socials', calendar: 'Calendar', settings: 'System' };
  const label = name === 'files' || name === 'pi-files' ? `Files · ${name === 'files' ? 'Friday' : 'Pi'}` : labels[name] || 'Workspace';
  $('#topbar-page').textContent = label;
}

function selectFileScope(scope) {
  if (scope === state.fileFeature) return;
  if (['files', 'pi-files'].includes(state.activeFeature) && !confirmDiscardFileChanges()) return;
  state.fileFeature = scope;
  void setFeature(scope);
}

function syncScopeSelectors() {
  for (const button of document.querySelectorAll('[data-file-scope]')) {
    const selected = button.dataset.fileScope === state.fileFeature;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  }
  $('#repo-page-title').textContent = 'Repositories';
  $('#repo-page-description').textContent = 'Friday workspace projects.';
  $('#clone-repo-url').setAttribute('aria-label', 'Repository Git URL');
}

async function loadFridayDirectory() {
  const data = await apiJson('/api/friday/settings', {}, 'friday-directory');
  state.fridayWorkspace = data.fridayChat?.directory || '';
  const directory = state.fridayWorkspace || 'Unavailable';
  elements.fridayWorkspaceDirectory.textContent = directory;
  elements.fridayWorkspaceDirectory.title = directory;
}

async function setFeature(name, { startPiPolling = true } = {}) {
  if (name === 'friday-settings' || name === 'pi-settings') name = 'settings';
  if (name === 'files') name = state.fileFeature;
  else if (name === 'pi-files') state.fileFeature = 'pi-files';
  if (name === state.activeFeature && ['files', 'pi-files'].includes(name) && !elements.fileEditorLayout.hidden) return;
  if (['files', 'pi-files'].includes(state.activeFeature) && !['files', 'pi-files'].includes(name) && !confirmDiscardFileChanges()) return;
  if (!featureViews.has(name)) return;
  state.activeFeature = name;
  if (name !== 'pi') stopPolling();
  if (name !== 'friday') {
    fridayChat.pause();
    stopFridayPiConversationPolling();
    stopFridaySessionListPolling();
  }
  if (name !== 'dashboard') {
    clearInterval(dashboardClockTimer);
    clearTimeout(dashboardTemperatureTimer);
  }
  sessionStorage.setItem('friday-files-scope', state.fileFeature === 'pi-files' ? 'pi' : 'friday');
  syncScopeSelectors(); updateTopbar(name);
  closeDrawer();
  const primaryName = name === 'pi-files' ? 'files' : name;
  for (const button of featureButtons) {
    const active = button.dataset.feature === primaryName; button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const view of new Set(featureViews.values())) {
    const visible = view === $('#dashboard-feature') ? name === 'dashboard'
      : view === $('#settings-feature') ? name === 'settings'
      : view === $('#files-feature') ? ['files', 'pi-files'].includes(name)
        : view === $('#repos-feature') ? name === 'repos'
          : view === $('#pi-feature') ? name === 'pi'
            : view === $('#notes-feature') ? name === 'notes'
              : view === $('#finances-feature') ? name === 'finances'
                : view === $('#socials-feature') ? name === 'socials'
                  : view === $('#calendar-feature') ? name === 'calendar' : name === 'friday';
    view.hidden = !visible;
  }
  document.dispatchEvent(new CustomEvent('friday:feature-change', { detail: name }));
  workspaceShell.updateFeature(name);
  syncFridaySubmenu();
  const fridayEntry = name === 'friday' ? fridayChat.enterView() : null;
  $('#system-devices-view').hidden = false;
  try {
    if (name === 'friday') await Promise.all([fridayChat.start(), fridayEntry, loadFridayDirectory()]);
    else if (name === 'pi') {
      await initializePi();
      if (startPiPolling) startPolling(0);
    }
    if (name === 'files' || name === 'pi-files') {
      elements.fileTitle.textContent = 'File preview';
      elements.fileMeta.textContent = 'Select a text file to preview it.';
      elements.fileContent.textContent = '';
      elements.fileContent.hidden = false;
      elements.fileEditorLayout.hidden = true;
      elements.fileEditActions.hidden = true;
      await loadFiles(state.files[name].path);
    }
    if (name === 'settings') await loadSettings(name);
    if (name === 'dashboard') await loadDashboard();
    if (name === 'repos') await loadRepos();
    if (name === 'notes') await loadNotes();
    if (name === 'finances') await loadFinances();
  } catch (error) {
    if (!isAbort(error)) {
      if (error.message.startsWith('Pi is not installed') && name === 'pi') location.assign('/pi-not-installed');
      else toast(error.message, 'error');
    }
  }
}

function openDrawer(id) {
  document.dispatchEvent(new Event('friday:drawer-open'));
  closeDrawer();
  document.getElementById(id)?.classList.add('open');
  elements.drawerBackdrop.hidden = false;
}

function closeDrawer() {
  document.querySelector('.context-sidebar.open')?.classList.remove('open');
  elements.drawerBackdrop.hidden = true;
  workspaceShell.closeNavigation();
}

function resizeComposer() {
  elements.input.style.height = 'auto';
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 192)}px`;
  updateControls();
}

let fridayPiConversationSync = null;
let fridayPiConversationRefreshAgain = false;
let fridayPiConversationDataRevision = 0;
const fridayPiSessionCards = elements.fridayPiSessionList ? createFridayPiSessionCards({
  container: elements.fridayPiSessionList,
  formatDate,
  onOpen: (session) => void openPiConversationFromFriday(session),
  onSaveVisibility: async (session, hiddenRepositories) => {
    fridayPiConversationDataRevision++;
    try {
      return await apiJson(`/api/friday/pi-conversations/${encodeURIComponent(session.runId)}/repository-visibility`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hiddenRepositories }),
      }, 'friday-pi-conversations');
    } finally { fridayPiConversationDataRevision++; }
  },
  onSaveProfile: async (session, profile) => {
    fridayPiConversationDataRevision++;
    try {
      return await apiJson(`/api/friday/pi-conversations/${encodeURIComponent(session.runId)}/profile`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
      }, 'friday-pi-conversations');
    } finally { fridayPiConversationDataRevision++; }
  },
  onRefresh: refreshFridayPiConversations,
  toast,
}) : null;

function loadFridayPiConversations() {
  if (fridayPiConversationSync) {
    fridayPiConversationRefreshAgain = true;
    return fridayPiConversationSync;
  }
  if (!fridayPiSessionCards) return Promise.resolve();
  fridayPiConversationSync = (async () => {
    try {
      let latestSessions = [];
      do {
        fridayPiConversationRefreshAgain = false;
        const rendered = await fetchAndRenderCurrent({
          load: () => apiJson('/api/friday/pi-conversations', {}, 'friday-pi-conversations'),
          currentRevision: () => fridayPiConversationDataRevision,
          render: ({ sessions = [] }) => { latestSessions = sessions; fridayPiSessionCards.render(sessions); },
        });
        if (!rendered) {
          fridayPiConversationRefreshAgain = true;
          continue;
        }
      } while (fridayPiConversationRefreshAgain);
      return latestSessions;
    } finally {
      fridayPiConversationSync = null;
      fridayPiConversationRefreshAgain = false;
    }
  })();
  return fridayPiConversationSync;
}

let fridayPiConversationPollTimer = null;
function stopFridayPiConversationPolling() {
  clearTimeout(fridayPiConversationPollTimer);
  fridayPiConversationPollTimer = null;
}

function scheduleFridayPiConversationPolling(sessions = []) {
  stopFridayPiConversationPolling();
  if (state.activeFeature !== 'friday' || document.visibilityState === 'hidden') return;
  const active = sessions.some((session) => session.opening || session.busy || session.queuedPrompts);
  fridayPiConversationPollTimer = setTimeout(() => {
    void refreshFridayPiConversations().catch(() => {});
  }, active ? 2_000 : 5_000);
}

async function refreshFridayPiConversations() {
  try {
    const sessions = await loadFridayPiConversations();
    scheduleFridayPiConversationPolling(sessions);
    return sessions;
  } catch (error) {
    scheduleFridayPiConversationPolling();
    throw error;
  }
}

async function openPiConversationFromFriday(session) {
  if (state.locks.has('session')) return;
  closeDrawer(); lock('session', true); stopPolling();
  const context = ++state.contextVersion;
  cancelRequest('history');
  try {
    const data = await apiJson('/api/session/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: session.cwd, path: session.path }),
    }, 'session-action');
    if (context !== state.contextVersion) return;
    if (data.runtimeId && data.runtimeId !== sessionStorage.getItem('friday-session-id')) { attachRuntime(data.runtimeId); return; }
    const wasInitialized = piInitialized;
    if (wasInitialized) {
      elements.workspace.value = data.workspace; state.workspace = data.workspace; state.currentSessionPath = data.sessionPath;
      state.history = []; state.historyTotal = 0;
    }
    await setFeature('pi', { startPiPolling: false });
    if (wasInitialized) {
      await Promise.all([loadHistory({ forceScroll: true }), loadModels(), loadThinkingLevels(), loadSessions(data.workspace, { quiet: true })]);
      const status = await apiJson('/api/status');
      setAgentBusy(status.busy, status.canAbort === true);
      renderPiContextUsage(status.contextUsage);
    }
  } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
  finally { lock('session', false); schedulePoll(0); }
}

const fridaySessionList = $('#friday-session-list');
const fridaySessionDetailsOpen = new Set();
let activeFridaySession = null;
let fridaySubmenuExpanded = false;
function syncFridaySubmenu() {
  elements.fridayNavEntry.classList.toggle('submenu-open', fridaySubmenuExpanded);
  elements.fridaySubmenuToggle.setAttribute('aria-expanded', String(fridaySubmenuExpanded));
  elements.fridaySubmenuToggle.setAttribute('aria-label', `${fridaySubmenuExpanded ? 'Hide' : 'Show'} Friday conversations`);
  elements.fridaySubmenuToggle.title = `${fridaySubmenuExpanded ? 'Hide' : 'Show'} Friday conversations`;
}
let fridaySessionsSync = null;
let fridaySessionsRefreshAgain = false;
function refreshFridaySessions() {
  if (fridaySessionsSync) {
    fridaySessionsRefreshAgain = true;
    return fridaySessionsSync;
  }
  fridaySessionsSync = (async () => {
    try {
      do {
        fridaySessionsRefreshAgain = false;
        await refreshFridaySessionsOnce();
      } while (fridaySessionsRefreshAgain);
    } finally {
      fridaySessionsSync = null;
      fridaySessionsRefreshAgain = false;
      scheduleFridaySessionListPolling();
    }
  })();
  return fridaySessionsSync;
}

async function refreshFridaySessionsOnce() {
  const data = await apiJson('/api/friday/sessions');
  if (!Array.isArray(data) && data.currentSession) activeFridaySession = String(data.currentSession);
  const sessions = Array.isArray(data) ? data : data.sessions || [];
  fridaySessionList.replaceChildren();
  for (const session of sessions) {
    const id = String(session.id ?? session.sessionId ?? '');
    const item = document.createElement('div');
    item.className = `session-item friday-session-item${id === activeFridaySession ? ' selected' : ''}`;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'session-open friday-session-open';
    open.setAttribute('aria-current', id === activeFridaySession ? 'true' : 'false');
    open.title = session.preview || session.name || 'New conversation';
    const title = document.createElement('span'); title.className = 'session-title friday-session-title'; title.textContent = session.name || session.title || 'New conversation';
    open.append(title);
    open.addEventListener('click', async () => {
      try {
        await apiJson(`/api/friday/sessions/${encodeURIComponent(id)}/open`, { method: 'POST' });
        activeFridaySession = id; await Promise.all([fridayChat.enterView(), refreshFridaySessions()]); closeDrawer();
      } catch (error) { toast(error.message, 'error'); }
    });
    const details = document.createElement('details'); details.className = 'friday-session-disclosure';
    details.open = fridaySessionDetailsOpen.has(id);
    const summary = document.createElement('summary'); summary.textContent = 'Details';
    summary.setAttribute('aria-label', `Details for ${session.name || 'conversation'}`);
    details.addEventListener('toggle', () => {
      if (details.open) fridaySessionDetailsOpen.add(id); else fridaySessionDetailsOpen.delete(id);
    });
    const meta = document.createElement('span'); meta.className = 'session-meta'; meta.textContent = `${formatDate(session.modified)} · ${session.messageCount || 0} msg`;
    const actions = document.createElement('div'); actions.className = 'session-actions friday-session-actions';
    const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'session-action'; rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${session.name || 'conversation'}`);
    rename.addEventListener('click', async () => {
      const name = prompt('Conversation name', session.name || session.title || '');
      if (name === null || !name.trim()) return;
      try { await apiJson(`/api/friday/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); await refreshFridaySessions(); }
      catch (error) { toast(error.message, 'error'); }
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'session-action danger'; remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${session.name || 'conversation'}`);
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete “${session.name || session.title || 'New conversation'}”?`)) return;
      try { await apiJson(`/api/friday/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (id === activeFridaySession) { activeFridaySession = null; await fridayChat.refreshTranscript(); } await refreshFridaySessions(); }
      catch (error) { toast(error.message, 'error'); }
    });
    actions.append(rename, remove); details.append(summary, meta, actions); item.append(open, details); fridaySessionList.append(item);
  }
  if (!sessions.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'No conversations yet'; fridaySessionList.append(empty); }
}

let fridaySessionListPollTimer = null;
function stopFridaySessionListPolling() {
  clearTimeout(fridaySessionListPollTimer);
  fridaySessionListPollTimer = null;
}

function scheduleFridaySessionListPolling() {
  stopFridaySessionListPolling();
  if (state.activeFeature !== 'friday' || document.visibilityState === 'hidden') return;
  fridaySessionListPollTimer = setTimeout(() => {
    void refreshFridaySessions().catch(() => {});
  }, 15_000);
}

async function refreshFridayAgentViewData() {
  await Promise.all([refreshFridaySessions(), refreshFridayPiConversations()]);
}

$('#friday-refresh-sessions').addEventListener('click', () => void refreshFridaySessions().catch((error) => toast(error.message, 'error')));
elements.fridayPiSessionsRefresh.addEventListener('click', () => void loadFridayPiConversations().catch((error) => toast(error.message, 'error')));
elements.fridayPiSessionsToggle.addEventListener('click', () => void loadFridayPiConversations().catch((error) => toast(error.message, 'error')));
elements.fridayReviewMemory.addEventListener('click', async () => {
  if (['files', 'pi-files'].includes(state.activeFeature) && !confirmDiscardFileChanges()) return;
  state.fileFeature = 'files';
  state.files.files.path = 'memory/daily';
  await setFeature('files');
});
$('#friday-new-conversation').addEventListener('click', async () => {
  try { const data = await apiJson('/api/friday/sessions', { method: 'POST' }); activeFridaySession = String(data.id ?? data.sessionId ?? data.session?.id); await fridayChat.refreshTranscript(); await refreshFridaySessions(); closeDrawer(); }
  catch (error) { toast(error.message, 'error'); }
});
void refreshFridaySessions().catch((error) => toast(error.message, 'error'));

elements.fridaySubmenuToggle.addEventListener('click', () => {
  fridaySubmenuExpanded = !fridaySubmenuExpanded;
  syncFridaySubmenu();
});

for (const button of featureButtons) button.addEventListener('click', () => void setFeature(button.dataset.feature));
for (const button of document.querySelectorAll('[data-file-scope]')) button.addEventListener('click', () => selectFileScope(button.dataset.fileScope));
for (const button of document.querySelectorAll('[data-open-drawer]')) button.addEventListener('click', () => openDrawer(button.dataset.openDrawer));
for (const button of document.querySelectorAll('[data-close-drawer]')) button.addEventListener('click', closeDrawer);
elements.drawerBackdrop.addEventListener('click', closeDrawer);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
window.addEventListener('online', () => {
  if (state.activeFeature === 'pi') startPolling(0);
  if (state.activeFeature === 'friday') {
    void fridayChat.enterView().catch((error) => toast(error.message, 'error'));
  }
});
window.addEventListener('offline', () => {
  stopPolling();
  stopFridayPiConversationPolling();
  stopFridaySessionListPolling();
  fridayChat.pause();
});
window.addEventListener('pagehide', () => {
  stopPolling();
  stopFridayPiConversationPolling();
  stopFridaySessionListPolling();
  fridayChat.stop();
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  if (state.activeFeature === 'pi' && piInitialized) startPolling(0);
  if (state.activeFeature === 'friday') {
    void fridayChat.start();
    void fridayChat.enterView().catch((error) => toast(error.message, 'error'));
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopPolling();
    stopFridayPiConversationPolling();
    stopFridaySessionListPolling();
    fridayChat.pause();
  } else if (state.activeFeature === 'pi' && piInitialized) {
    startPolling(0);
  } else if (state.activeFeature === 'friday') {
    void refreshFridayAgentViewData().catch((error) => toast(error.message, 'error'));
  }
});

elements.messages.addEventListener('scroll', () => { elements.jumpLatest.hidden = nearBottom(); }, { passive: true });
elements.jumpLatest.addEventListener('click', () => scrollToLatest());
elements.input.addEventListener('input', resizeComposer);
elements.input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!elements.send.disabled) elements.form.requestSubmit();
});

elements.workspace.addEventListener('input', () => {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(() => void loadWorkspaceSuggestions(elements.workspace.value), 150);
});

elements.workspace.addEventListener('change', async () => {
  if (state.locks.has('workspace')) return;
  const requested = elements.workspace.value;
  lock('workspace', true);
  const context = ++state.contextVersion;
  stopPolling(); cancelRequest('history'); cancelRequest('files'); cancelRequest('file-preview');
  try {
    const data = await apiJson('/api/settings/workspace', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: requested }),
    }, 'workspace-action');
    if (context !== state.contextVersion) return;
    if (data.runtimeId && data.runtimeId !== sessionStorage.getItem('friday-session-id')) {
      attachRuntime(data.runtimeId);
      return;
    }
    elements.workspace.value = data.workspace;
    state.workspace = data.workspace;
    state.history = []; state.historyTotal = 0; state.currentSessionPath = null;
    renderHistory([]);
    await Promise.all([loadHistory({ forceScroll: true }), loadModels(), loadThinkingLevels()]);
    await loadSessions(data.workspace);
    if (state.activeFeature === 'files' || state.activeFeature === 'pi-files') await loadFiles('');
    toast('Workspace changed');
  } catch (error) {
    if (!isAbort(error)) { elements.workspace.value = state.workspace; toast(error.message, 'error'); }
  } finally {
    lock('workspace', false);
    schedulePoll(0);
  }
});

elements.refreshSessions.addEventListener('click', async () => {
  try { await loadSessions(elements.workspace.value); }
  catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
});

elements.fileEdit.addEventListener('click', () => {
  elements.fileEditorLayout.dataset.editing = 'true';
  elements.fileContent.hidden = true;
  elements.fileEditorLayout.hidden = false;
  elements.fileEdit.hidden = true;
  elements.fileSave.hidden = false;
  elements.fileCancel.hidden = false;
  elements.fileEditor.focus();
});
elements.fileEditor.addEventListener('input', () => {
  elements.fileSave.disabled = elements.fileEditor.value === elements.fileEditor.dataset.original;
  if (elements.fileEditorLayout.dataset.editorType === 'markdown') {
    elements.fileMarkdownPreview.replaceChildren();
    renderMarkdown(elements.fileMarkdownPreview, elements.fileEditor.value);
  }
});
elements.fileSave.addEventListener('click', async () => {
  const feature = state.activeFeature;
  const path = state.files[feature]?.selectedFilePath;
  if (!path || !fileHasUnsavedChanges()) return;
  const scope = feature === 'files' ? 'friday' : 'pi';
  const content = elements.fileEditor.value;
  elements.fileSave.disabled = true;
  elements.fileEditStatus.textContent = 'Saving…';
  try {
    await apiJson(`/api/${scope}/files/content?path=${encodeURIComponent(path)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
    elements.fileEditor.dataset.original = content;
    elements.fileEditStatus.textContent = 'Saved';
    toast('File saved');
    await loadFile(path);
    await loadFiles(path.split('/').slice(0, -1).join('/'));
  } catch (error) {
    elements.fileEditStatus.textContent = error.message;
    elements.fileSave.disabled = false;
  }
});
elements.fileCancel.addEventListener('click', () => {
  const path = state.files[state.activeFeature]?.selectedFilePath;
  if (path) void loadFile(path);
});
$('#refresh-files').addEventListener('click', () => void loadFiles());
elements.filesUp.addEventListener('click', () => {
  const path = state.files[state.activeFeature]?.path;
  if (!path) return;
  void loadFiles(path.split('/').slice(0, -1).join('/'));
});
$('#refresh-devices').addEventListener('click', async () => { try { await loadDevices(); toast('Devices refreshed'); } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); } });
$('#refresh-settings').addEventListener('click', async () => { try { await loadSettings(); toast('System refreshed'); } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); } });
async function runPiUpdate(operation) {
  const extensionUpdate = operation === 'extensions';
  const status = extensionUpdate ? elements.piExtensionsUpdateStatus : elements.piRuntimeUpdateStatus;
  const button = $(extensionUpdate ? '#update-pi-extensions' : '#update-pi-runtime');
  const confirmed = window.confirm(extensionUpdate
    ? 'Update all user-installed Pi extensions now? Pi may download replacement package code. Project-local packages will be skipped.'
    : 'Update the Pi CLI on this host now? This replaces the installed Pi command used by future sessions.' );
  if (!confirmed) return;

  $('#update-pi-extensions').disabled = true;
  $('#update-pi-runtime').disabled = true;
  status.textContent = extensionUpdate ? 'Updating installed Pi extensions… This may take a few minutes.' : 'Updating the Pi CLI… This may take a few minutes.';
  try {
    const result = await apiJson(extensionUpdate ? '/api/pi/extensions/update' : '/api/pi/runtime/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
    });
    renderPiUpdateStatus(result);
  } catch (error) {
    status.textContent = error.message;
    toast(error.message, 'error');
  } finally {
    const update = await apiJson('/api/pi/update-status').catch(() => null);
    if (update) renderPiUpdateStatus(update);
    else {
      $('#update-pi-extensions').disabled = false;
      $('#update-pi-runtime').disabled = false;
    }
  }
}
$('#update-pi-extensions').addEventListener('click', () => void runPiUpdate('extensions'));
$('#update-pi-runtime').addEventListener('click', () => void runPiUpdate('runtime'));
$('#refresh-dashboard').addEventListener('click', async () => { try { await loadDashboard(); toast('Dashboard refreshed'); } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); } });
$('#restart-friday').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!window.confirm('Restart Friday now? Active chats and requests will be interrupted. The service should return shortly.')) return;
  button.disabled = true;
  $('#restart-friday-status').textContent = 'Scheduling restart…';
  try {
    await apiJson('/api/system/restart', { method: 'POST' });
    $('#restart-friday-status').textContent = 'Restart accepted. Friday should be back shortly.';
    toast('Friday is restarting. Reopen the page in a few seconds.');
  } catch (error) {
    $('#restart-friday-status').textContent = error.message;
    button.disabled = false;
  }
});

elements.model.addEventListener('change', async () => {
  const selected = elements.model.value;
  const [provider, ...parts] = selected.split('/');
  const modelId = parts.join('/');
  if (!provider || !modelId || selected === state.activeModel || state.locks.has('model')) return;
  lock('model', true);
  try {
    const data = await apiJson('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, modelId }) }, 'model-action');
    state.activeModel = `${data.model.provider}/${data.model.id}`; elements.model.value = state.activeModel; toast(`Model changed to ${data.model.name || data.model.id}`);
  } catch (error) {
    elements.model.value = state.activeModel; if (!isAbort(error)) toast(error.message, 'error');
  } finally { lock('model', false); }
});

elements.thinkingLevel.addEventListener('change', async () => {
  const next = elements.thinkingLevel.value;
  if (!next || next === state.activeThinkingLevel || state.locks.has('thinking')) return;
  lock('thinking', true);
  try {
    const data = await apiJson('/api/thinking-level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: next }) }, 'thinking-action');
    state.activeThinkingLevel = data.level; elements.thinkingLevel.value = data.level;
  } catch (error) {
    elements.thinkingLevel.value = state.activeThinkingLevel; if (!isAbort(error)) toast(error.message, 'error');
  } finally { lock('thinking', false); }
});

async function abortPiTurn() {
  if (!state.canAbort || state.stopping) return;
  state.stopping = true;
  updateControls();
  try {
    await apiJson('/api/abort', { method: 'POST' });
    setAgentBusy(true, false);
    startPolling();
  } catch (error) {
    if (!isAbort(error)) toast(error.message, 'error');
    try {
      const current = await apiJson('/api/status', {}, 'abort-recovery');
      setAgentBusy(current.busy, current.canAbort === true);
    } catch {}
  } finally {
    state.stopping = false;
    updateControls();
  }
}

elements.send.addEventListener('click', (event) => {
  if (!state.canAbort) return;
  event.preventDefault();
  void abortPiTurn();
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.canAbort) { await abortPiTurn(); return; }
  const message = elements.input.value.trim();
  if (!message || state.agentBusy || state.locks.has('chat')) return;
  const context = state.contextVersion;
  state.history = [...state.history, { role: 'user', content: message }]; renderHistory(state.history); scrollToLatest();
  elements.input.value = ''; resizeComposer(); lock('chat', true); setAgentBusy(true); startPolling();
  try {
    await apiJson('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    if (context !== state.contextVersion) return;
    await loadHistory({ forceScroll: true });
    await loadSessions(elements.workspace.value, { quiet: true });
    setAgentBusy(false);
    schedulePoll(idlePollInterval);
  } catch (error) {
    if (!isAbort(error)) {
      toast(error.message, 'error');
      try {
        const current = await apiJson('/api/status', {}, 'chat-recovery');
        setAgentBusy(current.busy, current.canAbort === true);
        if (current.busy) startPolling();
        else {
          await loadHistory();
          schedulePoll(idlePollInterval);
        }
      } catch { startPolling(); }
    }
  } finally { lock('chat', false); elements.input.focus(); }
});

const piSessionNameSuggestion = $('#pi-session-name-suggestion');
const piSessionCurrentName = $('#pi-session-current-name');
const piSessionNameValue = $('#pi-session-name-value');
let pendingPiSessionName = null;

function clearPiSessionNameSuggestion() {
  pendingPiSessionName = null;
  piSessionNameSuggestion.hidden = true;
}

async function suggestPiSessionName(runId) {
  const { sessions = [] } = await apiJson(`/api/sessions?cwd=${encodeURIComponent(elements.workspace.value)}`, {}, 'sessions');
  const session = sessions.find((item) => item.runId === runId);
  if (!session) {
    clearPiSessionNameSuggestion();
    return;
  }
  pendingPiSessionName = session;
  piSessionCurrentName.textContent = session.name || 'Untitled session';
  piSessionNameValue.textContent = generatePiSessionName(sessions, session.path);
  piSessionNameSuggestion.hidden = false;
}

$('#pi-regenerate-session-name').addEventListener('click', async (event) => {
  if (!pendingPiSessionName) return;
  if (pendingPiSessionName.path !== state.currentSessionPath || pendingPiSessionName.cwd !== elements.workspace.value) {
    clearPiSessionNameSuggestion();
    return;
  }
  const button = event.currentTarget; button.disabled = true;
  try { await suggestPiSessionName(pendingPiSessionName.runId); }
  catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
});

$('#pi-accept-session-name').addEventListener('click', async (event) => {
  const session = pendingPiSessionName;
  if (!session) return;
  if (session.path !== state.currentSessionPath || session.cwd !== elements.workspace.value) {
    clearPiSessionNameSuggestion();
    return;
  }
  const button = event.currentTarget; button.disabled = true;
  try {
    await apiJson('/api/session/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: session.cwd, path: session.path, name: piSessionNameValue.textContent }),
    }, 'session-action');
    clearPiSessionNameSuggestion();
    await loadSessions(session.cwd);
    toast('Session renamed');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
});

elements.reset.addEventListener('click', async () => {
  if (!elements.workspace.value || state.locks.has('session')) return;
  lock('session', true); ++state.contextVersion; stopPolling(); cancelRequest('history');
  try {
    const data = await apiJson('/api/session/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: elements.workspace.value }) }, 'session-action');
    if (data.runtimeId && data.runtimeId !== sessionStorage.getItem('friday-session-id')) {
      sessionStorage.setItem('friday-new-pi-run-id', data.runId);
      attachRuntime(data.runtimeId);
      return;
    }
    state.history = []; state.historyTotal = 0; state.currentSessionPath = data.sessionPath; renderHistory([]);
    await Promise.all([loadModels(), loadThinkingLevels(), loadSessions(data.workspace)]);
    renderPiContextUsage((await apiJson('/api/status', {}, 'poll-status')).contextUsage);
    await suggestPiSessionName(data.runId);
    toast('New session ready');
  } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
  finally {
    lock('session', false);
    schedulePoll(0);
    elements.input.focus();
  }
});

let piInitialized = false;
let piInitPromise = null;

function initializePi() {
  if (piInitialized) return Promise.resolve();
  if (piInitPromise) return piInitPromise;
  piInitPromise = (async () => {
    try {
      await loadWorkspace();
      await Promise.all([loadHistory(), loadModels(), loadThinkingLevels()]);
      await loadSessions(elements.workspace.value, { quiet: true });
      const newRunId = sessionStorage.getItem('friday-new-pi-run-id');
      if (newRunId) {
        await suggestPiSessionName(newRunId);
        sessionStorage.removeItem('friday-new-pi-run-id');
      }
      const current = await apiJson('/api/status', {}, 'startup-status');
      setAgentBusy(current.busy, current.canAbort === true);
      renderPiContextUsage(current.contextUsage);
      piInitialized = true;
    } finally {
      state.initializing = false;
      updateControls();
      resizeComposer();
      piInitPromise = null;
    }
  })();
  return piInitPromise;
}

elements.logout.addEventListener('click', async () => {
  elements.logout.disabled = true;
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Could not sign out');
    for (const key of ['friday-session-id', 'friday-client-id', 'friday-active-feature', 'friday-new-pi-run-id']) sessionStorage.removeItem(key);
    window.location.replace('/login');
  } catch (error) {
    elements.logout.disabled = false;
    toast(error.message, 'error');
  }
});

const workspaceShell = initializeWorkspaceShell({ navigate: setFeature, getFeature: () => state.activeFeature });
syncScopeSelectors();
updateTopbar();
updateControls();
void fridayChat.start();
void setFeature(state.activeFeature);

function attachCloneForm(formId, progressId) {
  const form = $(formId);
  const input = form.querySelector('input');
  const submit = form.querySelector('button[type="submit"]');
  const progress = $(progressId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const url = input.value;
    form.dataset.busy = 'true';
    input.disabled = submit.disabled = true;
    progress.hidden = false;
    try {
      await apiJson('/api/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      input.value = '';
      await loadRepos();
      toast('Repository cloned');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      delete form.dataset.busy;
      input.disabled = submit.disabled = false;
      progress.hidden = true;
    }
  });
}
attachCloneForm('#clone-repo-form', '#repo-clone-progress');
resetFinanceForm();
elements.financeMonth.value = currentFinanceMonth();
elements.financeSummaryPeriod.addEventListener('change', updateFinanceSummary);
elements.financeForm.addEventListener('submit', (event) => void addFinance(event));
elements.financeCancel.addEventListener('click', resetFinanceForm);
for (const filter of [elements.financeMonth, elements.financeTypeFilter, elements.financeCategoryFilter]) {
  filter.addEventListener('change', () => void loadFinances());
}
elements.financeExport.addEventListener('click', exportFinanceCsv);
