export function createFridayChat({ apiJson, renderMarkdown, toast, onHistory, onEnter }) {
  const messages = document.querySelector('#friday-messages');
  const form = document.querySelector('#friday-form');
  const input = document.querySelector('#friday-message');
  const send = document.querySelector('#friday-send');
  const model = document.querySelector('#friday-model');
  const thinking = document.querySelector('#friday-thinking-level');
  const status = document.querySelector('#friday-status');
  const taskBoard = document.querySelector('#friday-task-board');
  const contextUsage = document.querySelector('#friday-context-usage');
  const contextProgress = document.querySelector('#friday-context-progress');
  const contextLabel = document.querySelector('#friday-context-label');
  const announcement = document.querySelector('#friday-announcement');

  function renderContextUsage(usage) {
    if (!contextUsage || !contextProgress || !contextLabel) return;
    const tokens = Number.isFinite(usage?.tokens) ? usage.tokens : null;
    const windowSize = Number.isFinite(usage?.contextWindow) ? usage.contextWindow : null;
    const rawPercent = Number.isFinite(usage?.percent)
      ? usage.percent
      : tokens !== null && windowSize > 0 ? tokens / windowSize * 100 : null;
    const percent = rawPercent === null ? null : Math.max(0, Math.min(100, rawPercent));
    const formatTokens = (value) => value < 1_000 ? String(Math.round(value)) : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
    contextProgress.value = percent ?? 0;
    contextUsage.classList.toggle('warning', percent >= 80 && percent < 95);
    contextUsage.classList.toggle('critical', percent >= 95);
    const percentLabel = percent === null ? '' : percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
    contextLabel.textContent = percent === null
      ? 'Unavailable'
      : tokens !== null && windowSize !== null
        ? `${formatTokens(tokens)} / ${formatTokens(windowSize)} (${percentLabel})`
        : percentLabel;
    contextUsage.title = percent === null
      ? 'Context usage is not available yet'
      : tokens !== null && windowSize !== null
        ? `${Math.round(tokens).toLocaleString()} of ${Math.round(windowSize).toLocaleString()} context tokens (${percent.toFixed(1)}%)`
        : `${percent.toFixed(1)}% of the context window used`;
    contextProgress.setAttribute('aria-valuetext', percent === null ? 'Unavailable' : `${percent.toFixed(1)} percent`);
  }

  let history = [];
  let historyLoaded = false;
  let historySessionId = null;
  let optimistic = null;
  let busy = false;
  let canAbort = false;
  let stopping = false;
  let loading = false;
  let configuring = false;
  let currentModel = '';
  let currentThinking = 'off';
  let delegatedTask = null;
  let delegatedTasks = [];
  let taskBoardRevision = '';
  let started = false;
  let pollTimer = null;
  let syncPromise = null;
  let needsSync = false;
  let needsFullHistory = false;
  let lifecycleVersion = 0;
  let reachable = false;
  let scrollToLatestOnVisibleRender = false;

  function updateControls() {
    const inputDisabled = loading || busy || configuring;
    if (input.disabled !== inputDisabled) input.disabled = inputDisabled;
    const stopAvailable = canAbort && !stopping && !loading && !configuring;
    const sendDisabled = stopAvailable ? false : inputDisabled || !input.value.trim();
    if (send.disabled !== sendDisabled) send.disabled = sendDisabled;
    const sendMode = stopAvailable ? 'stop' : 'send';
    if (send.dataset.mode !== sendMode) {
      send.dataset.mode = sendMode;
      send.innerHTML = stopAvailable
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-5 14-2.5-5.5L5 12Z"/></svg>';
    }
    send.classList.toggle('stop', stopAvailable);
    const sendLabel = stopAvailable ? 'Stop Friday response' : 'Send message to Friday';
    if (send.getAttribute('aria-label') !== sendLabel) send.setAttribute('aria-label', sendLabel);
    const sendTitle = stopAvailable ? 'Stop response' : 'Send message';
    if (send.title !== sendTitle) send.title = sendTitle;
    const modelDisabled = loading || busy || configuring || !model.options.length;
    const thinkingDisabled = loading || busy || configuring || !thinking.options.length;
    if (model.disabled !== modelDisabled) model.disabled = modelDisabled;
    if (thinking.disabled !== thinkingDisabled) thinking.disabled = thinkingDisabled;
    const taskStages = { queued: 'Pi task queued', running: 'Pi is working', reviewing: 'Friday is reviewing', completed: 'Task complete', blocked: 'Task blocked', 'outcome-unknown': 'Task outcome unknown' };
    const taskStatus = delegatedTask && taskStages[delegatedTask.status]
      ? `${taskStages[delegatedTask.status]}${delegatedTask.label ? `: ${delegatedTask.label}` : ''}`
      : null;
    const activeTaskStatus = delegatedTask && ['queued', 'running', 'reviewing', 'outcome-unknown'].includes(delegatedTask.status);
    const statusText = loading ? 'Connecting…' : busy ? taskStatus || 'Friday is coordinating…' : configuring ? 'Updating settings…' : activeTaskStatus ? taskStatus : reachable ? 'Ready' : 'Reconnecting…';
    if (status.textContent !== statusText) status.textContent = statusText;
    const statusTitle = taskStatus
      ? `${taskStatus}${delegatedTask.summary || delegatedTask.detail ? ` — ${delegatedTask.summary || delegatedTask.detail}` : ''}`
      : statusText;
    if (status.title !== statusTitle) status.title = statusTitle;
    renderTaskBoard();
  }

  function renderTaskBoard() {
    if (!taskBoard) return;
    const visible = delegatedTasks.slice(0, 8);
    const revision = JSON.stringify(visible.map(({ id, label, status: taskStatus, summary, detail }) => [id, label, taskStatus, summary, detail]));
    if (revision === taskBoardRevision) return;
    taskBoardRevision = revision;
    taskBoard.hidden = visible.length === 0;
    taskBoard.replaceChildren();
    for (const task of visible) {
      const row = document.createElement('div'); row.className = `friday-task-row ${task.status}`;
      const heading = document.createElement('strong'); heading.textContent = `${task.label || 'Pi task'} · ${task.status}`;
      const detail = document.createElement('span'); detail.textContent = task.summary || task.detail || '';
      row.append(heading);
      if (detail.textContent) row.append(detail);
      taskBoard.append(row);
    }
  }

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 192)}px`;
    updateControls();
  }

  function applyState(runtime) {
    if (!runtime || configuring) return;
    currentModel = runtime.model ? `${runtime.model.provider}/${runtime.model.id}` : '';
    currentThinking = runtime.thinkingLevel || 'off';
    model.value = currentModel;
    thinking.value = currentThinking;
  }

  async function loadOptions() {
    const [models, levels] = await Promise.all([
      apiJson('/api/friday/models'),
      apiJson('/api/friday/thinking-levels'),
    ]);
    if (!started || configuring) return;
    model.replaceChildren();
    if (!models.current) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select model';
      placeholder.disabled = true;
      model.append(placeholder);
    }
    for (const item of models.models) {
      const option = document.createElement('option');
      option.value = `${item.provider}/${item.id}`;
      option.textContent = item.name || item.id;
      option.title = option.value;
      model.append(option);
    }
    thinking.replaceChildren();
    for (const level of levels.levels) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level[0].toUpperCase() + level.slice(1);
      thinking.append(option);
    }
    applyState({ model: models.current, thinkingLevel: levels.current });
    updateControls();
  }

  function nearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  }

  function scrollToLatest() {
    if (!messages.isConnected || !messages.getClientRects().length) return false;
    messages.scrollTop = messages.scrollHeight;
    return true;
  }

  function updateMessage(article, message) {
    const className = `message ${message.role}`;
    if (article.className !== className) article.className = className;
    if (article.dataset.renderRole !== message.role) article.dataset.renderRole = message.role;
    const content = article.querySelector('.message-content');
    if (article.renderedContent !== message.content) {
      content.replaceChildren();
      renderMarkdown(content, message.content);
      article.renderedContent = message.content;
    }
  }

  function makeMessage(message) {
    const article = document.createElement('article');
    const body = document.createElement('div');
    body.className = 'message-body';
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = message.role === 'user' ? 'You' : message.role === 'event' ? 'Friday · Task update' : 'Friday';
    const content = document.createElement('div');
    content.className = 'message-content';
    body.append(label, content);
    if (message.role === 'user') article.append(body);
    else {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = 'F';
      avatar.setAttribute('aria-hidden', 'true');
      article.append(avatar, body);
    }
    article.renderType = 'message';
    updateMessage(article, message);
    return article;
  }

  function updateToolGroup(group, records) {
    const counts = new Map();
    for (const { call } of records) counts.set(call.name || 'tool', (counts.get(call.name || 'tool') || 0) + 1);
    const names = [...counts].map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ''}`).join(', ');
    const errors = records.filter(({ result }) => result?.isError).length;
    const summaryText = `${records.length} tool call${records.length === 1 ? '' : 's'} · ${names}${errors ? ` · ${errors} failed` : ''}`;
    if (group.toolSummary.textContent !== summaryText) group.toolSummary.textContent = summaryText;
    const entries = group.toolEntries;
    const active = new Set();
    records.forEach(({ call, result }, index) => {
      const key = call.id || `${call.name || 'tool'}:${index}`;
      active.add(key);
      let entry = entries.get(key);
      if (!entry) {
        entry = document.createElement('details');
        entry.className = 'system-entry';
        const title = document.createElement('summary');
        const pre = document.createElement('pre');
        entry.append(title, pre);
        entry.toolTitle = title;
        entry.toolOutput = pre;
        entries.set(key, entry);
        group.toolList.append(entry);
      }
      entry.classList.toggle('error', Boolean(result?.isError));
      const titleText = `${call.name || 'tool'} · ${result ? result.isError ? 'error' : 'complete' : 'running'}`;
      if (entry.toolTitle.textContent !== titleText) entry.toolTitle.textContent = titleText;
      const output = [`Call\n${JSON.stringify(call.arguments || {}, null, 2)}`];
      if (result) output.push(`Result\n${result.content || '(empty)'}`);
      const renderedOutput = output.join('\n\n');
      if (entry.renderedOutput !== renderedOutput) {
        entry.toolOutput.textContent = renderedOutput;
        entry.renderedOutput = renderedOutput;
      }
    });
    for (const [key, entry] of entries) {
      if (!active.has(key)) { entry.remove(); entries.delete(key); }
    }
  }

  function makeToolGroup(records) {
    const group = document.createElement('details');
    group.className = 'tool-group';
    const summary = document.createElement('summary');
    const list = document.createElement('div');
    list.className = 'tool-group-list';
    group.append(summary, list);
    group.renderType = 'tools';
    group.toolSummary = summary;
    group.toolList = list;
    group.toolEntries = new Map();
    updateToolGroup(group, records);
    return group;
  }

  function historyBlocks() {
    const blocks = [];
    const calls = new Map();
    let piGroup = null;
    const flushPiGroup = () => {
      if (piGroup?.records.length) blocks.push({ type: 'tools', key: piGroup.key, records: piGroup.records });
      piGroup = null;
    };
    const addPiCall = (record, index) => {
      if (!piGroup) piGroup = { key: `tools:pi:${record.call.id || index}`, records: [] };
      piGroup.records.push(record);
      if (record.call.id) calls.set(record.call.id, record);
    };
    history.forEach((message, index) => {
      const messageKey = message.id ? `message:${message.id}` : `message:${message.role}:${index}`;
      if (message.role === 'tool') {
        const record = calls.get(message.toolCallId);
        if (record) record.result = message;
        else if (message.toolName?.startsWith('pi_')) {
          addPiCall({ call: { id: message.toolCallId, name: message.toolName, arguments: {} }, result: message }, index);
        } else {
          flushPiGroup();
          blocks.push({ type: 'tools', key: `tool:${message.id || message.toolCallId || index}`, records: [{ call: { id: message.toolCallId, name: message.toolName || 'tool', arguments: {} }, result: message }] });
        }
        return;
      }
      if (!['user', 'assistant', 'event'].includes(message.role)) return;
      if (message.role === 'user' || message.content) flushPiGroup();
      if (message.content) blocks.push({ type: 'message', key: messageKey, message });
      if (message.role !== 'assistant' || !message.toolCalls?.length) return;

      let otherRecords = [];
      let otherGroupIndex = 0;
      const flushOtherRecords = () => {
        if (!otherRecords.length) return;
        blocks.push({
          type: 'tools',
          key: `tools:${message.id || otherRecords.map(({ call }) => call.id).filter(Boolean).join(',') || index}:${otherGroupIndex++}`,
          records: otherRecords,
        });
        otherRecords = [];
      };
      for (const call of message.toolCalls) {
        const record = { call, result: null };
        if (call.name?.startsWith('pi_')) {
          flushOtherRecords();
          addPiCall(record, index);
        } else {
          flushPiGroup();
          otherRecords.push(record);
          if (call.id) calls.set(call.id, record);
        }
      }
      flushOtherRecords();
    });
    flushPiGroup();
    if (optimistic) blocks.push({ type: 'message', key: 'message:optimistic', message: { role: 'user', content: optimistic.content } });
    return blocks;
  }

  function render() {
    const stick = scrollToLatestOnVisibleRender || nearBottom();
    const blocks = historyBlocks();
    if (!blocks.length) {
      if (!messages.querySelector('.welcome')) {
        const welcome = document.createElement('div');
        welcome.className = 'welcome';
        const title = document.createElement('h2');
        title.textContent = 'Good to see you.';
        const copy = document.createElement('p');
        copy.textContent = 'Friday coordinates work and delegates project tasks to the best-fit Pi conversation. Pi tools run on the host account and are not sandboxed.';
        welcome.append(title, copy);
        messages.replaceChildren(welcome);
      }
      if (scrollToLatestOnVisibleRender && scrollToLatest()) scrollToLatestOnVisibleRender = false;
      return;
    }

    const current = new Map([...messages.children].filter((item) => item.renderKey).map((item) => [item.renderKey, item]));
    const desired = blocks.map((block) => {
      let item = current.get(block.key);
      if (item?.renderType !== block.type) item = null;
      if (!item) item = block.type === 'tools' ? makeToolGroup(block.records) : makeMessage(block.message);
      else if (block.type === 'tools') updateToolGroup(item, block.records);
      else updateMessage(item, block.message);
      item.renderKey = block.key;
      return item;
    });
    const retained = new Set(desired);
    for (const item of [...messages.children]) if (!retained.has(item)) item.remove();
    for (let index = 0; index < desired.length; index += 1) {
      const item = desired[index];
      const atIndex = messages.children[index] || null;
      if (atIndex !== item) messages.insertBefore(item, atIndex);
    }
    if (stick) messages.scrollTop = messages.scrollHeight;
    if (scrollToLatestOnVisibleRender && scrollToLatest()) scrollToLatestOnVisibleRender = false;
  }

  function historyUrl(fullHistory) {
    const query = new URLSearchParams();
    if (fullHistory) query.set('full', '1');
    else if (historyLoaded && historySessionId) {
      query.set('sessionId', historySessionId);
      const latest = history.at(-1);
      if (latest?.id) {
        query.set('afterId', latest.id);
        if (latest.revision) query.set('afterRevision', latest.revision);
        if (latest.prefixRevision) query.set('afterPrefix', latest.prefixRevision);
      }
    }
    const suffix = query.toString();
    return `/api/friday/history${suffix ? `?${suffix}` : ''}`;
  }

  function normalizeMessages(items) {
    const byId = new Map();
    const legacy = [];
    for (const item of items) {
      if (typeof item?.id === 'string') byId.set(item.id, item);
      else legacy.push(item);
    }
    const normalized = [...byId.values(), ...legacy];
    if (normalized.every((item) => Number.isFinite(item.sequence))) normalized.sort((a, b) => a.sequence - b.sequence);
    return normalized;
  }

  function mergeHistory(data, fullHistory) {
    const incoming = Array.isArray(data?.messages) ? data.messages : [];
    const responseSession = typeof data?.sessionId === 'string' ? data.sessionId : null;
    const sessionChanged = responseSession !== null && historySessionId !== null && responseSession !== historySessionId;
    const replaceSnapshot = fullHistory || !historyLoaded || data?.reset === true || sessionChanged || data?.incremental !== true;
    let changed = false;
    if (replaceSnapshot) {
      const next = normalizeMessages(incoming);
      changed = !historyLoaded || JSON.stringify(history) !== JSON.stringify(next);
      history = next;
    } else {
      const next = history.slice();
      const positions = new Map(next.map((message, index) => [message.id, index]));
      let canMerge = incoming.every((message) => typeof message?.id === 'string' && Number.isFinite(message.sequence));
      if (canMerge) {
        for (const message of incoming) {
          const index = positions.get(message.id);
          if (index === undefined) {
            positions.set(message.id, next.length);
            next.push(message);
            changed = true;
          } else if ((next[index].revision || JSON.stringify(next[index])) !== (message.revision || JSON.stringify(message))) {
            next[index] = message;
            changed = true;
          }
        }
      } else if (incoming.length) {
        historyLoaded = false;
        return false;
      }
      if (canMerge && changed) history = normalizeMessages(next);
    }
    if (responseSession !== null) historySessionId = responseSession;
    historyLoaded = true;
    return changed;
  }

  function sync(options = {}) {
    if (syncPromise) {
      needsSync = true;
      needsFullHistory ||= options.fullHistory === true;
      return syncPromise;
    }

    syncPromise = (async () => {
      let nextOptions = options;
      let result;
      try {
        do {
          needsSync = false;
          const fullHistory = nextOptions.fullHistory === true || needsFullHistory;
          needsFullHistory = false;
          try { result = await syncOnce({ ...nextOptions, fullHistory }); }
          catch (error) {
            if (!needsSync) throw error;
          }
          nextOptions = { withStatus: true, fullHistory: needsFullHistory };
        } while (needsSync && started);
        return result;
      } finally {
        syncPromise = null;
        needsSync = false;
        needsFullHistory = false;
      }
    })();
    return syncPromise;
  }

  async function syncOnce({ withStatus = false, fullHistory = false } = {}) {
    const version = lifecycleVersion;
    const [data, runtime] = await Promise.all([
      apiJson(historyUrl(fullHistory)),
      withStatus ? apiJson('/api/friday/status') : null,
    ]);
    if (!started || version !== lifecycleVersion) return;
    reachable = true;
    const previousReply = [...history].reverse().find((item) => item.role === 'assistant')?.content;
    const transcriptChanged = mergeHistory(data, fullHistory);
    const latestReply = [...history].reverse().find((item) => item.role === 'assistant')?.content;
    if (transcriptChanged && !loading && latestReply && latestReply !== previousReply) {
      announcement.textContent = `Friday: ${latestReply}`;
    }
    const userMessages = history.filter((item) => item.role === 'user');
    if (optimistic && userMessages.length > optimistic.after && userMessages[optimistic.after]?.content === optimistic.content) {
      optimistic = null;
    }
    if (runtime) {
      busy = runtime.busy;
      delegatedTask = runtime.delegatedTask || null;
      delegatedTasks = Array.isArray(runtime.tasks) ? runtime.tasks : delegatedTask ? [delegatedTask] : [];
      canAbort = runtime.canAbort === true;
      applyState(runtime);
      renderContextUsage(runtime.contextUsage);
    }
    if (transcriptChanged) render();
    updateControls();
  }

  function isVisible() {
    return document.visibilityState !== 'hidden' && messages.isConnected && messages.getClientRects().length > 0;
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(delay = busy || delegatedTasks.some((task) => ['queued', 'running', 'reviewing', 'outcome-unknown'].includes(task.status)) ? 2_000 : 15_000) {
    stopPolling();
    if (!started || !isVisible()) return;
    pollTimer = setTimeout(() => void poll(), delay);
  }

  async function poll() {
    if (!started || !isVisible()) return;
    try {
      await sync({ withStatus: true });
      schedulePoll();
    } catch {
      reachable = false;
      updateControls();
      schedulePoll(5_000);
    }
  }

  function onVisibilityChange() {
    if (!isVisible()) {
      stopPolling();
      return;
    }
    void poll();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  async function start() {
    if (started) return;
    started = true;
    lifecycleVersion += 1;
    loading = true;
    updateControls();
    try {
      await sync({ withStatus: true });
    } catch (error) {
      toast(error.message, 'error');
    }
    try {
      await loadOptions();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      loading = false;
      updateControls();
      schedulePoll();
    }
  }

  function enterView() {
    scrollToLatestOnVisibleRender = true;
    if (scrollToLatest()) scrollToLatestOnVisibleRender = false;
    requestAnimationFrame(() => {
      if (scrollToLatest()) scrollToLatestOnVisibleRender = false;
    });
    const transcript = started ? sync({ withStatus: true }) : start();
    return Promise.all([transcript, onEnter?.()]).finally(() => schedulePoll());
  }

  function refreshTranscript() {
    return sync({ withStatus: true, fullHistory: true });
  }

  function stop() {
    started = false;
    lifecycleVersion += 1;
    stopPolling();
  }

  model.addEventListener('change', async () => {
    const choice = model.value;
    if (!choice || choice === currentModel || busy || configuring) return;
    const [provider, ...parts] = choice.split('/');
    configuring = true;
    updateControls();
    try {
      const data = await apiJson('/api/friday/model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId: parts.join('/') }),
      });
      currentModel = `${data.model.provider}/${data.model.id}`;
      model.value = currentModel;
    } catch (error) {
      model.value = currentModel;
      toast(error.message, 'error');
    } finally {
      configuring = false;
      updateControls();
      void loadOptions().catch((error) => toast(error.message, 'error'));
    }
  });

  thinking.addEventListener('change', async () => {
    const level = thinking.value;
    if (!level || level === currentThinking || busy || configuring) return;
    configuring = true;
    updateControls();
    try {
      const data = await apiJson('/api/friday/thinking-level', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      currentThinking = data.level;
      thinking.value = currentThinking;
    } catch (error) {
      thinking.value = currentThinking;
      toast(error.message, 'error');
    } finally {
      configuring = false;
      updateControls();
    }
  });

  async function abortTurn() {
    if (!canAbort || stopping) return;
    stopping = true;
    updateControls();
    try {
      await apiJson('/api/friday/abort', { method: 'POST' });
      canAbort = false;
    } catch (error) {
      if (!isAbort(error)) toast(error.message, 'error');
    } finally {
      try { await sync({ withStatus: true }); }
      catch { reachable = false; }
      stopping = false;
      updateControls();
      schedulePoll();
    }
  }

  send.addEventListener('click', (event) => {
    if (!canAbort) return;
    event.preventDefault();
    void abortTurn();
  });

  input.addEventListener('input', resizeInput);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!send.disabled) form.requestSubmit();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (canAbort) { await abortTurn(); return; }
    const message = input.value.trim();
    if (!message || busy || loading) return;
    optimistic = { content: message, after: history.filter((item) => item.role === 'user').length };
    input.value = '';
    resizeInput();
    render();
    messages.scrollTop = messages.scrollHeight;
    busy = true;
    canAbort = true;
    updateControls();
    try {
      await apiJson('/api/friday/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    } catch (error) {
      // A failed request is not an accepted message, even if history cannot be reloaded.
      if (optimistic?.content === message) optimistic = null;
      render();
      if (!input.value) input.value = message;
      resizeInput();
      toast(error.message, 'error');
    } finally {
      try { await sync({ withStatus: true }); }
      catch { reachable = false; updateControls(); }
      schedulePoll();
      onHistory?.();
      input.focus();
    }
  });

  return { start, stop, pause: stopPolling, refreshTranscript, enterView };
}
