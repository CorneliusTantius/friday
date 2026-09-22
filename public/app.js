const messages = document.querySelector('#messages');
const form = document.querySelector('#chat-form');
const input = document.querySelector('#message');
const send = document.querySelector('#send');
const reset = document.querySelector('#reset');
const refreshSessions = document.querySelector('#refresh-sessions');
const sessionList = document.querySelector('#session-list');
const status = document.querySelector('#status');
const workspace = document.querySelector('#workspace');
const workspaceOptions = document.querySelector('#workspace-options');
const model = document.querySelector('#model');
const thinkingLevel = document.querySelector('#thinking-level');
let activeModel = '';
let activeThinkingLevel = 'off';
let suggestionRequest = 0;
let suggestionTimer;
let historyPollTimer = null;
let historyPollInFlight = false;
let filesRoot = '';
let filesPath = '';
let selectedFilePath = '';
let activeFeature = 'pi';

const featureButtons = [...document.querySelectorAll('[data-feature]')];
const featureViews = new Map([
  ['pi', document.querySelector('#pi-feature')],
  ['files', document.querySelector('#files-feature')],
  ['devices', document.querySelector('#devices-feature')],
  ['settings', document.querySelector('#settings-feature')],
]);
const fileList = document.querySelector('#file-list');
const filesPathLabel = document.querySelector('#files-path');
const filesUp = document.querySelector('#files-up');
const fileTitle = document.querySelector('#file-title');
const fileMeta = document.querySelector('#file-meta');
const fileContent = document.querySelector('#file-content');
const openFileInPi = document.querySelector('#open-file-in-pi');
const deviceList = document.querySelector('#device-list');
const deviceStatus = document.querySelector('#device-status');
const settingsList = document.querySelector('#settings-list');

const clientSessionId = sessionStorage.getItem('friday-session-id') || crypto.randomUUID();
sessionStorage.setItem('friday-session-id', clientSessionId);

function apiFetch(resource, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Friday-Session', clientSessionId);
  return fetch(resource, { ...options, headers });
}

function pretty(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function addSystemEntry(title, body, isError = false) {
  const details = document.createElement('details');
  details.className = `system-entry${isError ? ' error' : ''}`;

  const summary = document.createElement('summary');
  summary.textContent = title;
  details.append(summary);

  if (body) {
    const pre = document.createElement('pre');
    pre.textContent = body;
    details.append(pre);
  }

  messages.append(details);
}

function addCombinedToolEntry(toolCall, toolResult) {
  const isError = toolResult?.isError === true;
  const title = `Tool · ${toolCall.name}${toolResult ? isError ? ' · error' : ' · complete' : ''}`;
  const sections = [`Call\n${pretty(toolCall.arguments)}`];
  if (toolResult) {
    sections.push(`Result\n${toolResult.content || '(empty)'}`);
  }
  addSystemEntry(title, sections.join('\n\n'), isError);
}

function addMessage(message) {
  if (message.role === 'tool') {
    addSystemEntry(
      `${message.isError ? 'Error' : 'Result'} · ${message.toolName || 'tool'}`,
      message.content,
      message.isError,
    );
    return;
  }

  if (message.content) {
    const item = document.createElement('article');
    item.className = `message ${message.role}`;

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = message.role === 'user' ? 'You' : 'Pi';

    const text = document.createElement('div');
    text.className = 'message-content';
    text.textContent = message.content;
    item.append(label, text);
    messages.append(item);
  }
}

function scrollToLatest() {
  messages.lastElementChild?.scrollIntoView({ block: 'end' });
}

function setBusy(busy) {
  input.disabled = busy;
  send.disabled = busy;
  reset.disabled = busy;
  refreshSessions.disabled = busy;
  workspace.disabled = busy;
  model.disabled = busy || !model.value;
  thinkingLevel.disabled = busy || !thinkingLevel.value;
  status.textContent = busy ? 'Pi is working…' : 'Ready';
}

function setWorkspaceSuggestions(items) {
  workspaceOptions.replaceChildren();
  for (const option of items) {
    const item = document.createElement('option');
    item.value = option.path;
    item.label = option.label;
    workspaceOptions.append(item);
  }
}

async function loadWorkspaceSuggestions(prefix = '') {
  const request = ++suggestionRequest;
  const response = await apiFetch(`/api/workspaces?prefix=${encodeURIComponent(prefix)}`);
  if (!response.ok) return;
  const data = await response.json();
  if (request === suggestionRequest) {
    setWorkspaceSuggestions(data.workspaces);
  }
}

function attachRuntime(runtimeId) {
  sessionStorage.setItem('friday-session-id', runtimeId);
  window.location.reload();
}

function sessionState(item) {
  if (item.busy) return { label: 'Working', className: 'working' };
  if (item.running) return { label: 'Running', className: 'running' };
  return { label: 'Saved', className: 'saved' };
}

function renderSessions(items, currentPath) {
  sessionList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'session-empty';
    empty.textContent = 'No saved sessions';
    sessionList.append(empty);
    return;
  }

  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-item${item.path === currentPath ? ' selected' : ''}`;
    button.title = item.preview || item.path;

    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = item.name;

    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `${new Date(item.modified).toLocaleDateString()} · ${item.messageCount} messages`;

    const state = sessionState(item);
    const stateLabel = document.createElement('span');
    stateLabel.className = `session-state ${state.className}`;
    stateLabel.textContent = state.label;

    const details = document.createElement('span');
    details.className = 'session-details';
    details.append(meta, stateLabel);
    button.append(title, details);
    button.addEventListener('click', () => {
      const currentRuntimeId = sessionStorage.getItem('friday-session-id');
      if (item.path === currentPath && item.runtimeId === currentRuntimeId) return;
      if (item.runtimeId && item.runtimeId !== currentRuntimeId) {
        attachRuntime(item.runtimeId);
        return;
      }
      void openSession(item.path);
    });
    sessionList.append(button);
  }
}

async function loadSessions(cwd = workspace.value) {
  const response = await apiFetch(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Could not load sessions');
  }

  const data = await response.json();
  workspace.value = data.workspace;
  renderSessions(data.sessions, data.currentSession);
}

async function openSession(sessionPath) {
  setBusy(true);
  try {
    const response = await apiFetch('/api/session/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: workspace.value, path: sessionPath }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not open session');
    }
    if (data.runtimeId && data.runtimeId !== sessionStorage.getItem('friday-session-id')) {
      attachRuntime(data.runtimeId);
      return;
    }
    await loadHistory();
    await loadModels();
    await loadThinkingLevels();
    await loadSessions(data.workspace);
  } catch (error) {
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  } finally {
    setBusy(false);
    input.focus();
  }
}


async function loadModels() {
  const response = await apiFetch('/api/models');
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Could not load models');
  }

  const data = await response.json();
  model.replaceChildren();
  for (const item of data.models) {
    const option = document.createElement('option');
    option.value = `${item.provider}/${item.id}`;
    option.textContent = `${item.name || item.id} · ${item.provider}`;
    option.title = option.value;
    model.append(option);
  }

  activeModel = data.current ? `${data.current.provider}/${data.current.id}` : '';
  model.value = activeModel;
  model.disabled = data.models.length === 0;
}

async function loadThinkingLevels() {
  const response = await apiFetch('/api/thinking-levels');
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Could not load thinking levels');
  }

  const data = await response.json();
  thinkingLevel.replaceChildren();
  for (const level of data.levels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level;
    thinkingLevel.append(option);
  }

  activeThinkingLevel = data.current || data.levels[0] || 'off';
  thinkingLevel.value = activeThinkingLevel;
  thinkingLevel.disabled = data.levels.length === 0;
}

async function loadWorkspace() {
  const [statusResponse, workspacesResponse] = await Promise.all([
    apiFetch('/api/status'),
    apiFetch('/api/workspaces'),
  ]);
  if (!statusResponse.ok || !workspacesResponse.ok) {
    throw new Error('Could not load workspace settings');
  }

  const current = await statusResponse.json();
  const data = await workspacesResponse.json();
  setWorkspaceSuggestions(data.workspaces);
  workspace.value = current.preferredWorkspace || current.workspace;
  await loadSessions(workspace.value);
}

async function loadHistory({ scroll = true } = {}) {
  const shouldStickToBottom = scroll || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  const response = await apiFetch('/api/history');
  if (!response.ok) {
    throw new Error('Could not load conversation');
  }
  const data = await response.json();
  messages.replaceChildren();
  const pendingToolCalls = new Map();
  for (const message of data.messages) {
    if (message.role === 'tool') {
      const toolCall = pendingToolCalls.get(message.toolCallId);
      if (toolCall) {
        addCombinedToolEntry(toolCall, message);
        pendingToolCalls.delete(message.toolCallId);
      } else {
        addMessage(message);
      }
      continue;
    }

    addMessage(message);
    for (const toolCall of message.toolCalls || []) {
      pendingToolCalls.set(toolCall.id, toolCall);
    }
  }

  for (const toolCall of pendingToolCalls.values()) {
    addCombinedToolEntry(toolCall, null);
  }
  if (shouldStickToBottom) scrollToLatest();
}

function stopHistoryPolling() {
  if (historyPollTimer) clearTimeout(historyPollTimer);
  historyPollTimer = null;
}

function scheduleHistoryPoll() {
  stopHistoryPolling();
  historyPollTimer = setTimeout(() => void pollHistory(), 3_000);
}

async function pollHistory() {
  if (historyPollInFlight) return;
  historyPollInFlight = true;
  try {
    const response = await apiFetch('/api/status');
    if (!response.ok) throw new Error('Could not read Pi status');
    const data = await response.json();
    if (data.busy) {
      status.textContent = 'Pi is working…';
      await loadHistory({ scroll: false });
      scheduleHistoryPoll();
    } else {
      await loadHistory({ scroll: false });
      stopHistoryPolling();
      setBusy(false);
    }
  } catch {
    scheduleHistoryPoll();
  } finally {
    historyPollInFlight = false;
  }
}

function startHistoryPolling() {
  if (!historyPollTimer) scheduleHistoryPoll();
}

async function syncHistoryPolling() {
  try {
    const response = await apiFetch('/api/status');
    if (!response.ok) return;
    const data = await response.json();
    if (data.busy) {
      setBusy(true);
      startHistoryPolling();
    } else {
      stopHistoryPolling();
    }
  } catch {
    // Initial status errors are reported by the regular page loader.
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderFiles(data) {
  filesRoot = data.root;
  filesPath = data.path;
  filesPathLabel.textContent = data.path ? `/${data.path}` : '/';
  filesUp.disabled = !data.path;
  fileList.replaceChildren();

  if (!data.entries.length) {
    const empty = document.createElement('p');
    empty.className = 'session-empty';
    empty.textContent = 'Empty directory';
    fileList.append(empty);
    return;
  }

  for (const entry of data.entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-item';
    button.title = entry.path;

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = entry.type === 'directory' ? '▰' : '▱';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.name;
    button.append(icon, name);

    if (entry.type === 'file') {
      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = formatBytes(entry.size);
      button.append(size);
      button.addEventListener('click', () => void loadFile(entry.path));
    } else {
      button.addEventListener('click', () => void loadFiles(entry.path));
    }
    fileList.append(button);
  }
}

async function loadFiles(path = filesPath) {
  const params = new URLSearchParams({ cwd: workspace.value });
  if (filesRoot) params.set('root', filesRoot);
  if (filesRoot || path) params.set('path', path);
  const response = await apiFetch(`/api/files?${params}`);
  if (!response.ok) {
    const data = await response.json();
    fileList.replaceChildren();
    fileContent.textContent = data.error || 'Could not load files';
    fileTitle.textContent = 'Files error';
    fileMeta.textContent = '';
    return;
  }
  renderFiles(await response.json());
}

async function loadFile(path) {
  const params = new URLSearchParams({ cwd: workspace.value, path });
  if (filesRoot) params.set('root', filesRoot);
  const response = await apiFetch(`/api/files/content?${params}`);
  if (!response.ok) {
    const data = await response.json();
    fileTitle.textContent = 'Preview unavailable';
    fileMeta.textContent = data.error || 'Could not read file';
    fileContent.textContent = '';
    openFileInPi.disabled = true;
    selectedFilePath = '';
    return;
  }

  const data = await response.json();
  selectedFilePath = data.workspacePath || '';
  fileTitle.textContent = data.path.split('/').pop() || data.path;
  fileMeta.textContent = `${data.path} · ${formatBytes(data.size)} · modified ${new Date(data.modified).toLocaleString()}${data.workspacePath ? '' : ' · outside active Pi workspace'}`;
  fileContent.textContent = data.content;
  openFileInPi.disabled = !data.workspacePath;e;
}

function renderDevices(data) {
  deviceList.replaceChildren();
  deviceStatus.className = `feature-notice${data.available ? '' : ' warning'}`;
  deviceStatus.textContent = data.available
    ? `${data.devices.length} device${data.devices.length === 1 ? '' : 's'} found.`
    : data.error;

  for (const device of data.devices) {
    const card = document.createElement('article');
    card.className = 'device-card';

    const heading = document.createElement('div');
    heading.className = 'device-heading';
    const name = document.createElement('span');
    name.className = 'device-name';
    name.textContent = device.hostname;
    const state = document.createElement('span');
    state.className = `device-state${device.online ? ' online' : ''}`;
    state.textContent = device.online ? 'Online' : 'Offline';
    heading.append(name, state);

    const meta = document.createElement('div');
    meta.className = 'device-meta';
    meta.textContent = `${device.self ? 'This host' : device.os}${device.dnsName ? ` · ${device.dnsName}` : ''}`;
    card.append(heading, meta);

    if (device.addresses.length) {
      const addresses = document.createElement('div');
      addresses.className = 'device-addresses';
      addresses.textContent = device.addresses.join(' · ');
      card.append(addresses);
    }
    deviceList.append(card);
  }
}

async function loadDevices() {
  const response = await apiFetch('/api/devices');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load devices');
  renderDevices(data);
}

function renderSettings(data) {
  settingsList.replaceChildren();
  const values = [
    ['Server', `${data.host}:${data.port}`],
    ['Pi command', data.piCommand],
    ['Pi status', data.busy ? 'Working' : data.piRunning ? 'Running' : 'Stopped'],
    ['Workspace setting', data.preferredWorkspace || data.workspace],
    ['Active Pi workspace', data.workspace],
    ['Workspace roots', data.workspaceRoots.join(', ')],
    ['Current session', data.sessionPath || 'None'],
    ['Model', data.model ? `${data.model.name} · ${data.model.provider}` : 'None'],
    ['Thinking level', data.thinkingLevel],
  ];
  for (const [label, value] of values) {
    const item = document.createElement('div');
    item.className = 'setting-card';
    const key = document.createElement('span');
    key.className = 'setting-label';
    key.textContent = label;
    const content = document.createElement('span');
    content.className = 'setting-value';
    content.textContent = value;
    item.append(key, content);
    settingsList.append(item);
  }
}

async function loadSettings() {
  const response = await apiFetch('/api/settings');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load settings');
  renderSettings(data);
}

async function setFeature(name) {
  activeFeature = name;
  for (const button of featureButtons) {
    const active = button.dataset.feature === name;
    button.classList.toggle('active', active);
    button.toggleAttribute('aria-current', active);
  }
  for (const [feature, view] of featureViews) {
    view.hidden = feature !== name;
  }

  try {
    if (name === 'files') await loadFiles(filesPath);
    if (name === 'devices') await loadDevices();
    if (name === 'settings') await loadSettings();
  } catch (error) {
    const target = name === 'devices' ? deviceStatus : name === 'settings' ? settingsList : fileContent;
    target.textContent = `Error: ${error.message}`;
  }
}

for (const button of featureButtons) {
  button.addEventListener('click', () => void setFeature(button.dataset.feature));
}

filesUp.addEventListener('click', () => {
  if (!filesPath) return;
  filesPath = filesPath.split('/').slice(0, -1).join('/');
  void loadFiles(filesPath);
});

document.querySelector('#refresh-files').addEventListener('click', () => void loadFiles(filesPath));
openFileInPi.addEventListener('click', () => {
  if (!selectedFilePath) return;
  input.value = `Please inspect ${selectedFilePath}`;
  void setFeature('pi');
  input.focus();
});
document.querySelector('#refresh-devices').addEventListener('click', () => void loadDevices());
document.querySelector('#refresh-settings').addEventListener('click', () => void loadSettings());

model.addEventListener('change', async () => {
  const [provider, ...modelParts] = model.value.split('/');
  const modelId = modelParts.join('/');
  if (!provider || !modelId || model.value === activeModel) return;

  model.disabled = true;
  status.textContent = 'Changing model…';
  try {
    const response = await apiFetch('/api/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, modelId }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not change model');
    }
    activeModel = `${data.model.provider}/${data.model.id}`;
    model.value = activeModel;
  } catch (error) {
    model.value = activeModel;
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  } finally {
    model.disabled = false;
    status.textContent = 'Ready';
  }
});

thinkingLevel.addEventListener('change', async () => {
  const nextLevel = thinkingLevel.value;
  if (!nextLevel || nextLevel === activeThinkingLevel) return;

  thinkingLevel.disabled = true;
  status.textContent = 'Changing thinking level…';
  try {
    const response = await apiFetch('/api/thinking-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: nextLevel }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not change thinking level');
    }
    activeThinkingLevel = data.level;
    thinkingLevel.value = activeThinkingLevel;
  } catch (error) {
    thinkingLevel.value = activeThinkingLevel;
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  } finally {
    thinkingLevel.disabled = false;
    status.textContent = 'Ready';
  }
});

workspace.addEventListener('input', () => {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(() => {
    void loadWorkspaceSuggestions(workspace.value);
  }, 120);
});

async function updateWorkspaceSessions() {
  messages.replaceChildren();
  sessionList.replaceChildren();
  filesRoot = '';
  filesPath = '';
  selectedFilePath = '';
  openFileInPi.disabled = true;
  status.textContent = 'Choose a session or start a new one';
  try {
    const response = await apiFetch('/api/settings/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: workspace.value }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not save workspace');
    }
    workspace.value = data.workspace;
    await loadSessions(data.workspace);
    if (activeFeature === 'files') await loadFiles('');
  } catch (error) {
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  }
}

workspace.addEventListener('change', () => {
  void updateWorkspaceSessions();
});

refreshSessions.addEventListener('click', async () => {
  refreshSessions.disabled = true;
  try {
    await loadSessions(workspace.value);
  } catch (error) {
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  } finally {
    refreshSessions.disabled = false;
  }
});



input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!send.disabled) form.requestSubmit();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  addMessage({ role: 'user', content: message });
  input.value = '';
  setBusy(true);
  startHistoryPolling();

  try {
    const response = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Chat request failed');
    }
    await loadHistory();
    await loadSessions(workspace.value);
  } catch (error) {
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  } finally {
    stopHistoryPolling();
    setBusy(false);
    input.focus();
  }
});

reset.addEventListener('click', async () => {
  if (!workspace.value || !confirm('Start a new Pi session in this workspace?')) return;
  setBusy(true);
  try {
    const response = await apiFetch('/api/session/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: workspace.value }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not reset session');
    }
    messages.replaceChildren();
    await loadModels();
    await loadThinkingLevels();
    await loadSessions(data.workspace);
  } catch (error) {
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  } finally {
    setBusy(false);
    input.focus();
  }
});

(async () => {
  try {
    await loadWorkspace();
    await loadHistory();
    await loadModels();
    await loadThinkingLevels();
    await loadSessions(workspace.value);
    await syncHistoryPolling();
  } catch (error) {
    addMessage({ role: 'assistant', content: `Error: ${error.message}` });
  }
})();
