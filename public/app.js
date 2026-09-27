const fridayChatModule = await import('./friday-chat.js').catch(() => null);

const $ = (selector) => document.querySelector(selector);

const elements = {
  messages: $('#messages'), form: $('#chat-form'), input: $('#message'), send: $('#send'), reset: $('#reset'),
  refreshSessions: $('#refresh-sessions'), sessionList: $('#session-list'), status: $('#status'),
  workspace: $('#workspace'), workspaceOptions: $('#workspace-options'), model: $('#model'),
  thinkingLevel: $('#thinking-level'), sessionSubtitle: $('#session-subtitle'), jumpLatest: $('#jump-latest'),
  fileList: $('#file-list'), filesPathLabel: $('#files-path'), filesUp: $('#files-up'), filesRootLabel: $('#files-root'),
  fileTitle: $('#file-title'), fileMeta: $('#file-meta'), fileContent: $('#file-content'),
  deviceList: $('#device-list'), deviceStatus: $('#device-status'),
  fridaySettingsList: $('#friday-settings-list'), settingsList: $('#settings-list'),
  serverSettingsList: $('#server-settings-list'), extensionsList: $('#extensions-list'),
  connectionDot: $('#connection-dot'), connectionLabel: $('#connection-label'),
  toastRegion: $('#toast-region'), drawerBackdrop: $('#drawer-backdrop'), agentOrb: $('.header .agent-orb'),
  logout: $('#logout'),
  financeForm: $('#finance-form'), financeList: $('#finance-list'), financeStatus: $('#finance-status'),
  financeBalance: $('#finance-balance'), financeIncome: $('#finance-income'), financeExpenses: $('#finance-expenses'),
  financeSubmit: $('#finance-submit'), financeCancel: $('#finance-cancel'),
  financeMonth: $('#finance-month'), financeTypeFilter: $('#finance-type-filter'),
  financeCategoryFilter: $('#finance-category-filter'), financeExport: $('#finance-export'),
  announcement: $('#announcement'),
};

const featureButtons = [...document.querySelectorAll('[data-feature]')];
const featureViews = new Map([
  ['friday', $('#friday-feature')],
  ['pi', $('#pi-feature')],
  ['files', $('#files-feature')], ['pi-files', $('#files-feature')],
  ['repos', $('#repos-feature')], ['pi-repos', $('#pi-repos-feature')], ['notes', $('#notes-feature')],
  ['finances', $('#finances-feature')],
  ['settings', $('#settings-feature')], ['friday-settings', $('#settings-feature')], ['pi-settings', $('#settings-feature')],
]);
const savedFeature = sessionStorage.getItem('friday-active-feature');
const url = new URL(window.location.href);
const requestedFeature = url.searchParams.get('feature');
const initialFeature = featureViews.has(requestedFeature) ? requestedFeature : featureViews.has(savedFeature) ? savedFeature : 'friday';
if (requestedFeature) {
  url.searchParams.delete('feature');
  history.replaceState(null, '', url);
}

const state = {
  activeFeature: initialFeature,
  activeModel: '',
  activeThinkingLevel: 'off',
  agentBusy: false,
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
};

const requests = new Map();
let suggestionTimer;
let suggestionSequence = 0;
let pollTimer = null;
let pollInFlight = false;
const activePollInterval = 3_000;
const idlePollInterval = 30_000;
let eventSource = null;
let eventReconnectTimer = null;
let eventRefreshTimer = null;
let eventNeedsFullRefresh = false;
let eventConnected = false;
let eventConnectAttempt = 0;

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

function setConnection(online) {
  elements.connectionDot.className = `connection-dot ${online ? 'online' : 'offline'}`;
  elements.connectionLabel.textContent = online ? 'Host online' : 'Host offline';
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
  elements.send.disabled = unavailable || state.agentBusy || state.locks.has('chat') || !elements.input.value.trim();
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

function setAgentBusy(busy) {
  state.agentBusy = busy;
  updateControls();
}

function pretty(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function safeMarkdownHref(destination) {
  const value = destination.replace(/\\([()<>\\ ])/g, '$1');
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^(https?:|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function markdownLinkAt(source, start) {
  if (source[start] !== '[') return null;
  const labelEnd = source.indexOf('](', start + 1);
  if (labelEnd < 0 || source.slice(start, labelEnd).includes('\n')) return null;

  let depth = 1;
  let escaped = false;
  for (let index = labelEnd + 2; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '\n') return null;
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) {
      const raw = source.slice(labelEnd + 2, index).trim();
      const match = raw.match(/^(<[^>]+>|(?:\\.|[^\s])+?)(?:\s+(?:"[^"]*"|'[^']*'))?$/);
      if (!match) return null;
      const destination = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1];
      return { label: source.slice(start + 1, labelEnd), destination, end: index + 1 };
    }
  }
  return null;
}

function appendPlainTextWithLinks(parent, source) {
  const pattern = /https?:\/\/[^\s<>]+/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    let url = match[0];
    while (/[.,!?;:]$/.test(url)) url = url.slice(0, -1);
    while (url.endsWith(')') && (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) {
      url = url.slice(0, -1);
    }
    if (!url) continue;
    const start = match.index;
    parent.append(document.createTextNode(source.slice(cursor, start)));
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noreferrer noopener'; link.textContent = url;
    parent.append(link);
    cursor = start + url.length;
  }
  parent.append(document.createTextNode(source.slice(cursor)));
}

function appendInlineMarkdown(parent, source) {
  const formatting = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  while (cursor < source.length) {
    formatting.lastIndex = cursor;
    const formatted = formatting.exec(source);
    let link = null;
    let linkIndex = -1;
    for (let index = source.indexOf('[', cursor); index >= 0; index = source.indexOf('[', index + 1)) {
      link = markdownLinkAt(source, index);
      if (link) { linkIndex = index; break; }
    }
    const formatIndex = formatted?.index ?? Infinity;
    if (!link) linkIndex = Infinity;
    if (!formatted && !link) {
      appendPlainTextWithLinks(parent, source.slice(cursor));
      break;
    }

    const tokenIndex = Math.min(formatIndex, linkIndex);
    appendPlainTextWithLinks(parent, source.slice(cursor, tokenIndex));
    if (link && linkIndex <= formatIndex) {
      const href = safeMarkdownHref(link.destination);
      if (href) {
        const anchor = document.createElement('a');
        anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noreferrer noopener'; appendInlineMarkdown(anchor, link.label);
        parent.append(anchor);
      } else {
        parent.append(document.createTextNode(source.slice(linkIndex, link.end)));
      }
      cursor = link.end;
      continue;
    }

    const token = formatted[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code'); code.textContent = token.slice(1, -1); parent.append(code);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong'); appendInlineMarkdown(strong, token.slice(2, -2)); parent.append(strong);
    } else {
      const emphasis = document.createElement('em'); appendInlineMarkdown(emphasis, token.slice(1, -1)); parent.append(emphasis);
    }
    cursor = formatted.index + token.length;
  }
}

function splitTableRow(line) {
  let source = line.trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && source[index + 1] === '|') {
      cell += '|'; index += 1;
    } else if (character === '`') {
      inCode = !inCode; cell += character;
    } else if (character === '|' && !inCode) {
      cells.push(cell.trim()); cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignments(line) {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (cells.length < 2) return null;
  const alignments = cells.map((cell) => {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });
  return alignments.every(Boolean) ? alignments : null;
}

function renderMarkdownTable(parent, headers, alignments, rows) {
  const wrapper = document.createElement('div'); wrapper.className = 'table-wrap';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headers.forEach((value, index) => {
    const cell = document.createElement('th'); cell.style.textAlign = alignments[index]; appendInlineMarkdown(cell, value); headerRow.append(cell);
  });
  head.append(headerRow); table.append(head);
  const body = document.createElement('tbody');
  for (const values of rows) {
    const row = document.createElement('tr');
    headers.forEach((_, index) => {
      const cell = document.createElement('td'); cell.style.textAlign = alignments[index]; appendInlineMarkdown(cell, values[index] || ''); row.append(cell);
    });
    body.append(row);
  }
  table.append(body); wrapper.append(table); parent.append(wrapper);
}

function renderMarkdown(parent, source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const element = document.createElement('p');
    paragraph.forEach((line, index) => { if (index) element.append(document.createElement('br')); appendInlineMarkdown(element, line); });
    parent.append(element); paragraph = [];
  };
  const flushList = () => { if (list) parent.append(list.element); list = null; };
  const flushCode = () => { const pre = document.createElement('pre'); pre.textContent = code.join('\n'); parent.append(pre); code = null; };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (code) { if (line.trim() === '```') flushCode(); else code.push(line); continue; }
    if (line.trim().startsWith('```')) { flushParagraph(); flushList(); code = []; continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }

    const alignments = index + 1 < lines.length ? tableAlignments(lines[index + 1]) : null;
    if (line.includes('|') && alignments) {
      const headers = splitTableRow(line);
      if (headers.length === alignments.length) {
        flushParagraph(); flushList();
        const rows = [];
        let rowIndex = index + 2;
        while (rowIndex < lines.length && lines[rowIndex].trim() && lines[rowIndex].includes('|')) {
          rows.push(splitTableRow(lines[rowIndex])); rowIndex += 1;
        }
        renderMarkdownTable(parent, headers, alignments, rows);
        index = rowIndex - 1;
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList();
      const element = document.createElement(`h${heading[1].length}`); appendInlineMarkdown(element, heading[2]); parent.append(element); continue;
    }
    const listItem = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, element: document.createElement(ordered ? 'ol' : 'ul') }; }
      const item = document.createElement('li'); appendInlineMarkdown(item, listItem[1]); list.element.append(item); continue;
    }
    if (line.startsWith('>')) {
      flushParagraph(); flushList();
      const quote = document.createElement('blockquote'); appendInlineMarkdown(quote, line.replace(/^>\s?/, '')); parent.append(quote); continue;
    }
    paragraph.push(line);
  }
  if (code) flushCode();
  flushParagraph(); flushList();
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
  updateSessionSubtitle();
}

function updateSessionSubtitle() {
  const workspaceName = elements.workspace.value.split('/').filter(Boolean).pop();
  elements.sessionSubtitle.textContent = workspaceName ? `${workspaceName} · ${state.agentBusy ? 'working' : 'ready'}` : 'Your workspace copilot';
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function closeEventStream() {
  eventConnectAttempt += 1;
  if (eventReconnectTimer) clearTimeout(eventReconnectTimer);
  if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
  eventReconnectTimer = null;
  eventRefreshTimer = null;
  eventNeedsFullRefresh = false;
  eventConnected = false;
  cancelRequest('event-token');
  if (eventSource) eventSource.close();
  eventSource = null;
}

function scheduleEventRefresh(full = false) {
  eventNeedsFullRefresh ||= full;
  if (eventRefreshTimer || !eventConnected) return;
  const context = state.contextVersion;
  eventRefreshTimer = setTimeout(async () => {
    eventRefreshTimer = null;
    if (!eventConnected || context !== state.contextVersion) return;
    if (requests.has('history')) {
      scheduleEventRefresh(eventNeedsFullRefresh);
      return;
    }

    const fullRefresh = eventNeedsFullRefresh;
    eventNeedsFullRefresh = false;
    try {
      await loadHistory({ limit: fullRefresh ? null : 10 });
      if (fullRefresh) await loadSessions(elements.workspace.value, { quiet: true });
    } catch (error) {
      if (!isAbort(error)) {
        closeEventStream();
        startPolling();
        scheduleEventReconnect();
      }
    }
  }, 300);
}

function scheduleEventReconnect(delay = 3_000) {
  if (!('EventSource' in window) || eventReconnectTimer) return;
  eventReconnectTimer = setTimeout(() => {
    eventReconnectTimer = null;
    void connectEventStream();
  }, delay);
}

async function connectEventStream() {
  if (!('EventSource' in window)) {
    startPolling();
    return;
  }

  const context = state.contextVersion;
  const attempt = ++eventConnectAttempt;
  if (eventReconnectTimer) clearTimeout(eventReconnectTimer);
  eventReconnectTimer = null;
  if (eventSource) eventSource.close();
  eventSource = null;
  eventConnected = false;

  try {
    const { token } = await apiJson('/api/events/token', { method: 'POST' }, 'event-token');
    if (attempt !== eventConnectAttempt || context !== state.contextVersion) return;

    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    eventSource = source;
    source.onopen = () => {
      if (eventSource !== source || context !== state.contextVersion) return;
      eventConnected = true;
      stopPolling();
      setConnection(true);
      scheduleEventRefresh(true);
    };
    source.addEventListener('runtime', (event) => {
      if (eventSource !== source || context !== state.contextVersion) return;
      if (!eventConnected) {
        eventConnected = true;
        stopPolling();
        setConnection(true);
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.sessionPath && state.currentSessionPath && data.sessionPath !== state.currentSessionPath) return;
      setAgentBusy(data.busy === true);
      updateSessionSubtitle();
      scheduleEventRefresh(data.kind !== 'activity' || data.busy !== true || data.activity === 'session_info_changed');
    });
    source.onerror = () => {
      if (eventSource !== source) return;
      source.close();
      eventSource = null;
      eventConnected = false;
      startPolling();
      scheduleEventReconnect();
    };
  } catch (error) {
    if (attempt !== eventConnectAttempt || context !== state.contextVersion || isAbort(error)) return;
    startPolling();
    scheduleEventReconnect();
  }
}

function schedulePoll(delay = state.agentBusy ? activePollInterval : idlePollInterval) {
  stopPolling();
  if (eventConnected) return;
  pollTimer = setTimeout(() => void pollHistory(), delay);
}

async function pollHistory() {
  if (pollInFlight) { schedulePoll(); return; }
  const context = state.contextVersion;
  const wasBusy = state.agentBusy;
  pollInFlight = true;
  try {
    const data = await apiJson('/api/status', {}, 'poll-status');
    if (context !== state.contextVersion) {
      schedulePoll();
      return;
    }
    setConnection(true);
    setAgentBusy(data.busy);
    updateSessionSubtitle();

    if (data.busy) {
      await loadHistory({ limit: 10 });
    } else {
      if (wasBusy) await loadHistory();
      await loadSessions(elements.workspace.value, { quiet: true });
    }

    if (context !== state.contextVersion) {
      schedulePoll();
      return;
    }
    schedulePoll();
  } catch (error) {
    if (context === state.contextVersion) {
      if (!isAbort(error)) setConnection(false);
      schedulePoll(state.agentBusy ? 5_000 : idlePollInterval);
    }
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  schedulePoll(500);
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
  } catch (error) {
    if (!isAbort(error)) setConnection(false);
  }
}

function sessionState(item) {
  if (item.busy) return { label: 'Working', className: 'working' };
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

function renderSessions(items, currentPath) {
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
  const name = action === 'rename'
    ? window.prompt('Rename session', item.name)?.trim()
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
    updateSessionSubtitle();
  } finally {
    elements.refreshSessions.classList.remove('loading');
  }
}

function attachRuntime(runtimeId) {
  closeEventStream();
  sessionStorage.setItem('friday-session-id', runtimeId);
  sessionStorage.setItem('friday-active-feature', 'pi');
  window.location.assign('/?feature=pi');
}

async function openSession(sessionPath) {
  if (state.locks.has('session')) return;
  closeDrawer();
  lock('session', true);
  elements.sessionSubtitle.textContent = 'Opening session…';
  const context = ++state.contextVersion;
  closeEventStream();
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
    closeDrawer();
  } catch (error) {
    if (!isAbort(error)) toast(error.message, 'error');
  } finally {
    lock('session', false);
    updateSessionSubtitle();
    schedulePoll();
    void connectEventStream();
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
  setConnection(true);
  setWorkspaceSuggestions(data.workspaces);
  elements.workspace.value = current.preferredWorkspace || current.workspace;
  state.workspace = elements.workspace.value;
  setAgentBusy(current.busy);
  await loadSessions(elements.workspace.value);
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

async function loadFiles(path = state.files[state.activeFeature]?.path || '') {
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
  const context = state.contextVersion;
  const feature = state.activeFeature;
  const files = state.files[feature];
  elements.fileTitle.textContent = path.split('/').pop() || path;
  elements.fileMeta.textContent = 'Loading preview…';
  try {
    const scope = feature === 'files' ? 'friday' : 'pi';
    const data = await apiJson(`/api/${scope}/files/content?path=${encodeURIComponent(path)}`, {}, `file-preview-${feature}`);
    if (context !== state.contextVersion || state.activeFeature !== feature) return;
    files.selectedFilePath = data.path;
    elements.fileTitle.textContent = data.path.split('/').pop() || data.path;
    elements.fileMeta.textContent = `${data.path} · ${formatBytes(data.size)} · ${new Date(data.modified).toLocaleString()} · read only`;
    elements.fileContent.textContent = data.content;
    for (const item of elements.fileList.querySelectorAll('.file-item')) item.classList.toggle('selected', item.title === data.path);
  } catch (error) {
    if (isAbort(error)) return;
    files.selectedFilePath = ''; elements.fileTitle.textContent = 'Preview unavailable'; elements.fileMeta.textContent = error.message; elements.fileContent.textContent = '';
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
  if (state.activeFeature === 'settings') renderDevices(data);
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

function renderSettings(data) {
  const friday = data.fridayChat;
  renderSettingCards(elements.fridaySettingsList, friday ? [
    ['Status', friday.busy ? 'Working' : friday.running ? 'Ready' : 'Standby'],
    ['Model', friday.model ? `${friday.model.name} · ${friday.model.provider}` : 'Default'],
    ['Conversation directory', friday.directory],
    ['Saved sessions', friday.sessionsDirectory],
    ['Current session', friday.sessionPath || 'No active session'],
  ] : [['Status', 'Restart Friday server to view chat settings']]);
  renderSettingCards(elements.settingsList, [
    ['Pi status', data.busy ? 'Working' : data.piRunning ? 'Ready' : 'Standby'],
    ['Model', data.model ? `${data.model.name} · ${data.model.provider}` : 'None'],
    ['Thinking', data.thinkingLevel],
    ['Workspace', data.workspace],
    ['Current session', data.sessionPath || 'No active session'],
  ]);
  renderSettingCards(elements.serverSettingsList, [
    ['System usage', formatUsage(data.systemUsage)],
    ['Server', `${data.host}:${data.port}`],
    ['Pi command', data.piCommand],
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

function renderRepos(list, repos, scope) {
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
        await apiJson(scope === 'pi' ? '/api/pi/repos/pull' : '/api/repos/pull', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: repo.name }),
        });
        toast(`Synced ${repo.name}`);
      } catch (error) {
        if (!isAbort(error)) toast(error.message, 'error');
      } finally {
        try { if (scope === 'pi') await loadPiRepos(); else await loadRepos(); }
        catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
      }
    });
    card.append(pull);
    list.append(card);
  }
}

async function loadRepos() {
  const data = await apiJson('/api/repos', {}, 'repos');
  renderRepos($('#repo-list'), data.repos || [], 'friday');
}

async function loadPiRepos() {
  const data = await apiJson('/api/pi/repos', {}, 'pi-repos');
  renderRepos($('#pi-repo-list'), data.repos || [], 'pi');
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
    for (const note of notes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-item';
      button.textContent = note.name || note.path || 'Untitled note';
      button.addEventListener('click', async () => {
        list.querySelector('.file-item.selected')?.classList.remove('selected');
        button.classList.add('selected');
        title.textContent = note.name || note.path || 'Untitled note';
        meta.textContent = note.path || 'Markdown note';
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
      list.append(button);
    }
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
    status.textContent = [data.status, data.lastSync ? `Last sync: ${data.lastSync}` : '', data.error ? `Error: ${data.error}` : ''].filter(Boolean).join(' · ') || 'Not synced yet';
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
      if (endpoint.endsWith('/run')) panel.querySelector('.sync-status').textContent = `${data.pushed ? `Pushed ${data.copied} files` : 'Already up to date'} · Last sync: ${data.lastSync}`;
    } catch (error) { panel.querySelector('.sync-status').textContent = `Error: ${error.message}`; }
    finally { delete panel.dataset.busy; save.disabled = run.disabled = false; }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); void submit(`/api/${scope}/sync/settings`, { owner: form.elements.owner.value.trim(), repo: form.elements.repo.value.trim() }); });
  run.addEventListener('click', () => void submit(`/api/${scope}/sync/run`));
}

async function loadSettings(feature = state.activeFeature) {
  const endpoint = { 'friday-settings': '/api/friday/settings', 'pi-settings': '/api/pi/settings', settings: '/api/system/settings' }[feature] || '/api/settings';
  const settings = await apiJson(endpoint, {}, `settings-${feature}`);
  if (state.activeFeature !== feature) return;
  if (feature === 'friday-settings' || feature === 'pi-settings') {
    const scope = feature === 'friday-settings' ? 'friday' : 'pi';
    await Promise.all([loadProviderAuth(scope), loadSyncSettings(scope)]);
  }
  if (feature === 'friday-settings') {
    const friday = settings.fridayChat || settings;
    renderSettingCards(elements.fridaySettingsList, [
      ['Status', friday.busy ? 'Working' : friday.running ? 'Ready' : 'Standby'],
      ['Model', friday.model ? `${friday.model.name} · ${friday.model.provider}` : 'Default'],
      ['Conversation directory', friday.directory || 'Unavailable'],
      ['Saved sessions', friday.sessionsDirectory || 'Unavailable'],
      ['Current session', friday.sessionPath || 'No active session'],
    ]);
  } else if (feature === 'pi-settings') {
    renderSettings({ ...settings, fridayChat: null, systemUsage: undefined });
  } else {
    renderSettingCards(elements.serverSettingsList, [
      ['System usage', formatUsage(settings.systemUsage)],
      ['Server', settings.host && settings.port ? `${settings.host}:${settings.port}` : 'Unavailable'],
      ['Pi command', settings.piCommand || 'Unavailable'],
    ]);
    const githubStatus = $('#github-cli-status');
    const deviceStatus = elements.deviceStatus;
    githubStatus.textContent = 'Checking GitHub CLI…';
    deviceStatus.className = 'feature-notice';
    deviceStatus.textContent = 'Loading connected devices…';
    elements.deviceList.replaceChildren();
    const devicesRequest = apiJson('/api/devices', {}, 'devices').then((devices) => {
      if (state.activeFeature === feature) renderDevices(devices);
    }).catch((error) => {
      if (state.activeFeature !== feature || isAbort(error)) return;
      deviceStatus.className = 'feature-notice warning';
      deviceStatus.textContent = `Could not load devices: ${error.message}`;
    });
    const githubRequest = apiJson('/api/system/github').then((github) => {
      if (state.activeFeature === feature) githubStatus.textContent = `Available: ${github.available ? 'Yes' : 'No'} · Authenticated: ${github.authenticated ? 'Yes' : 'No'}`;
    }).catch((error) => {
      if (state.activeFeature === feature && !isAbort(error)) githubStatus.textContent = `Status unavailable: ${error.message}`;
    });
    await Promise.all([devicesRequest, githubRequest]);
  }
}

const fridayChat = fridayChatModule
  ? fridayChatModule.createFridayChat({ apiJson, renderMarkdown, toast })
  : {
      start() { $('#friday-status').textContent = 'Restart Friday server to enable chat'; },
      stop() {},
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
  const monthEntries = entries.filter((entry) => !elements.financeMonth.value || entry.date.startsWith(elements.financeMonth.value));
  const totals = monthEntries.reduce((result, entry) => {
    result[entry.type] += entry.amount;
    return result;
  }, { income: 0, expense: 0 });
  elements.financeIncome.textContent = money(totals.income);
  elements.financeExpenses.textContent = money(totals.expense);
  elements.financeBalance.textContent = money(totals.income - totals.expense);
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

async function setFeature(name) {
  if (!featureViews.has(name)) return;
  state.activeFeature = name;
  sessionStorage.setItem('friday-active-feature', name);
  closeDrawer();
  for (const button of featureButtons) {
    const active = button.dataset.feature === name; button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const view of new Set(featureViews.values())) {
    const visible = view === $('#settings-feature')
      ? ['settings', 'friday-settings', 'pi-settings'].includes(name)
      : view === $('#files-feature') ? ['files', 'pi-files'].includes(name)
        : view === $('#repos-feature') ? name === 'repos'
          : view === $('#pi-repos-feature') ? name === 'pi-repos'
            : view === $('#pi-feature') ? name === 'pi'
              : view === $('#notes-feature') ? name === 'notes'
                : view === $('#finances-feature') ? name === 'finances' : name === 'friday';
    view.hidden = !visible;
  }
  $('#friday-settings-view').hidden = name !== 'friday-settings';
  $('#pi-settings-view').hidden = name !== 'pi-settings';
  $('#system-settings-view').hidden = name !== 'settings';
  $('#system-devices-view').hidden = name !== 'settings';
  $('#settings-feature h1').textContent = { 'friday-settings': 'Friday settings', 'pi-settings': 'Pi settings', settings: 'System' }[name] || 'System';
  $('#settings-feature .page-header p').textContent = {
    'friday-settings': 'General chat and its provider credentials.',
    'pi-settings': 'Coding agent, extensions, and provider credentials.',
    settings: 'Server information and connected devices.',
  }[name] || 'Server information and connected devices.';
  try {
    if (name === 'friday') await fridayChat.start();
    else if (!['repos', 'pi-repos', 'notes', 'files', 'pi-files', 'finances', 'friday-settings', 'settings'].includes(name)) await initializePi();
    if (name === 'files' || name === 'pi-files') {
      elements.fileTitle.textContent = 'File preview';
      elements.fileMeta.textContent = 'Select a text file to preview it.';
      elements.fileContent.textContent = '';
      await loadFiles(state.files[name].path);
    }
    if (['friday-settings', 'pi-settings', 'settings'].includes(name)) await loadSettings(name);
    if (name === 'repos') await loadRepos();
    if (name === 'pi-repos') await loadPiRepos();
    if (name === 'notes') await loadNotes();
    if (name === 'finances') await loadFinances();
  } catch (error) {
    if (!isAbort(error)) {
      if (error.message.startsWith('Pi is not installed') && name.startsWith('pi')) location.assign('/pi-not-installed');
      else toast(error.message, 'error');
    }
  }
}

function openDrawer(id) {
  closeDrawer();
  document.getElementById(id)?.classList.add('open');
  elements.drawerBackdrop.hidden = false;
}

function closeDrawer() {
  document.querySelector('.context-sidebar.open')?.classList.remove('open');
  elements.drawerBackdrop.hidden = true;
}

function resizeComposer() {
  elements.input.style.height = 'auto';
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 192)}px`;
  updateControls();
}

for (const button of featureButtons) button.addEventListener('click', () => void setFeature(button.dataset.feature));
for (const button of document.querySelectorAll('[data-open-drawer]')) button.addEventListener('click', () => openDrawer(button.dataset.openDrawer));
for (const button of document.querySelectorAll('[data-close-drawer]')) button.addEventListener('click', closeDrawer);
elements.drawerBackdrop.addEventListener('click', closeDrawer);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
window.addEventListener('online', () => {
  setConnection(true);
  if (piInitialized) void connectEventStream();
});
window.addEventListener('offline', () => {
  closeEventStream();
  stopPolling();
  setConnection(false);
});
window.addEventListener('pagehide', () => {
  closeEventStream();
  fridayChat.stop();
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  if (piInitialized) void connectEventStream();
  if (state.activeFeature === 'friday') void fridayChat.start();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.initializing && !eventConnected) {
    void connectEventStream();
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
  closeEventStream();
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
    await Promise.all([loadSessions(data.workspace), loadHistory({ forceScroll: true }), loadModels(), loadThinkingLevels()]);
    if (state.activeFeature === 'files' || state.activeFeature === 'pi-files') await loadFiles('');
    toast('Workspace changed');
  } catch (error) {
    if (!isAbort(error)) { elements.workspace.value = state.workspace; toast(error.message, 'error'); }
  } finally {
    lock('workspace', false);
    schedulePoll();
    void connectEventStream();
  }
});

elements.refreshSessions.addEventListener('click', async () => {
  try { await loadSessions(elements.workspace.value); }
  catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
});

$('#refresh-files').addEventListener('click', () => void loadFiles());
elements.filesUp.addEventListener('click', () => {
  const path = state.files[state.activeFeature]?.path;
  if (!path) return;
  void loadFiles(path.split('/').slice(0, -1).join('/'));
});
$('#refresh-devices').addEventListener('click', async () => { try { await loadDevices(); toast('Devices refreshed'); } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); } });
$('#refresh-settings').addEventListener('click', async () => { try { await loadSettings(); toast('System refreshed'); } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); } });

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

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
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
        setAgentBusy(current.busy);
        if (current.busy) startPolling();
        else {
          await loadHistory();
          schedulePoll(idlePollInterval);
        }
      } catch { setConnection(false); startPolling(); }
    }
  } finally { lock('chat', false); elements.input.focus(); }
});

elements.reset.addEventListener('click', async () => {
  if (!elements.workspace.value || state.locks.has('session')) return;
  lock('session', true); ++state.contextVersion; closeEventStream(); stopPolling(); cancelRequest('history');
  try {
    const data = await apiJson('/api/session/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: elements.workspace.value }) }, 'session-action');
    if (data.runtimeId && data.runtimeId !== sessionStorage.getItem('friday-session-id')) {
      attachRuntime(data.runtimeId);
      return;
    }
    state.history = []; state.historyTotal = 0; state.currentSessionPath = data.sessionPath; renderHistory([]);
    await Promise.all([loadModels(), loadThinkingLevels(), loadSessions(data.workspace)]);
    updateSessionSubtitle(); toast('New session ready');
  } catch (error) { if (!isAbort(error)) toast(error.message, 'error'); }
  finally {
    lock('session', false);
    schedulePoll();
    void connectEventStream();
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
      const current = await apiJson('/api/status', {}, 'startup-status');
      setAgentBusy(current.busy);
      setConnection(true);
      piInitialized = true;
      if (current.busy) startPolling();
      else schedulePoll(idlePollInterval);
      void connectEventStream();
    } finally {
      state.initializing = false;
      updateControls();
      updateSessionSubtitle();
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
    for (const key of ['friday-session-id', 'friday-client-id', 'friday-active-feature']) sessionStorage.removeItem(key);
    window.location.replace('/login');
  } catch (error) {
    elements.logout.disabled = false;
    toast(error.message, 'error');
  }
});

setConnection(navigator.onLine);
updateControls();
void fridayChat.start();
if (state.activeFeature !== 'friday') void setFeature(state.activeFeature);

function attachCloneForm(formId, progressId, endpoint, reload) {
  const form = $(formId);
  const input = form.querySelector('input');
  const submit = form.querySelector('button[type="submit"]');
  const progress = $(progressId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const url = input.value;
    input.disabled = true;
    submit.disabled = true;
    progress.hidden = false;
    try {
      await apiJson(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      input.value = '';
      await reload();
      toast('Repository cloned');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      input.disabled = false;
      submit.disabled = false;
      progress.hidden = true;
    }
  });
}
attachCloneForm('#clone-repo-form', '#friday-clone-progress', '/api/repos', loadRepos);
attachCloneForm('#clone-pi-repo-form', '#pi-clone-progress', '/api/pi/repos', loadPiRepos);
resetFinanceForm();
elements.financeMonth.value = currentFinanceMonth();
elements.financeForm.addEventListener('submit', (event) => void addFinance(event));
elements.financeCancel.addEventListener('click', resetFinanceForm);
for (const filter of [elements.financeMonth, elements.financeTypeFilter, elements.financeCategoryFilter]) {
  filter.addEventListener('change', () => void loadFinances());
}
elements.financeExport.addEventListener('click', exportFinanceCsv);
