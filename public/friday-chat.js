export function createFridayChat({ apiJson, renderMarkdown, toast, onHistory, onEnter }) {
  const messages = document.querySelector('#friday-messages');
  const form = document.querySelector('#friday-form');
  const input = document.querySelector('#friday-message');
  const send = document.querySelector('#friday-send');
  const model = document.querySelector('#friday-model');
  const thinking = document.querySelector('#friday-thinking-level');
  const status = document.querySelector('#friday-status');
  const taskBoard = document.querySelector('#friday-task-board');
  const taskPanel = document.querySelector('#friday-task-panel');
  const chatQueue = document.querySelector('#friday-chat-queue');
  const stopButton = document.querySelector('#friday-stop');
  const contextUsage = document.querySelector('#friday-context-usage');
  const contextProgress = document.querySelector('#friday-context-progress');
  const contextLabel = document.querySelector('#friday-context-label');
  const compactionStatus = document.querySelector('#friday-compaction-status');
  const announcement = document.querySelector('#friday-announcement');
  const POLL_INTERVAL_MS = 2_000;

  function renderContextUsage(usage) {
    const warningText = {
      failed: 'Automatic compaction failed; your message is retained. Retry or shorten the conversation before continuing.',
      'unknown-window': 'The 75% compaction threshold is unavailable for this model; SDK automatic compaction and overflow recovery remain enabled.',
      configuration: 'The 75% compaction threshold could not be configured; SDK automatic compaction and overflow recovery remain enabled.',
    }[usage?.compactionWarning] || '';
    if (compactionStatus) {
      compactionStatus.hidden = !warningText;
      compactionStatus.textContent = warningText;
    }
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
  let optimistic = [];
  let optimisticSequence = 0;
  let sendError = '';
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
  let followsLatest = true;
  let scrollFramePending = false;
  let scrollResizeObserver = null;
  let observedLastBlock = null;

  function renderChatQueue() {
    if (!chatQueue) return;
    const visible = optimistic.filter((item) => !['completed', 'cancelled'].includes(item.status));
    chatQueue.hidden = visible.length === 0;
    chatQueue.replaceChildren();
    for (const item of visible) {
      const row = document.createElement('div');
      row.className = `friday-chat-queue-row ${item.status}`;
      const description = document.createElement('span');
      const states = { sending: 'Sending…', queued: 'Queued', running: 'Friday is responding', failed: `Could not send: ${item.error || 'unknown error'}` };
      const state = item.status === 'queued' && item.position ? `Queued · ${item.position}` : states[item.status] || 'Queued';
      description.textContent = `${state} · ${item.content}`;
      row.append(description);
      if (item.status === 'queued' && item.id) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'secondary';
        cancel.textContent = 'Cancel queued message';
        cancel.setAttribute('aria-label', `Cancel queued message: ${item.content}`);
        cancel.addEventListener('click', () => { void cancelQueuedMessage(item); });
        row.append(cancel);
      }
      if (item.status === 'failed') {
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'secondary';
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', () => { optimistic = optimistic.filter((entry) => entry !== item); renderChatQueue(); updateControls(); });
        row.append(dismiss);
      }
      chatQueue.append(row);
    }
  }

  function updateControls() {
    const inputDisabled = loading || configuring;
    if (input.disabled !== inputDisabled) input.disabled = inputDisabled;
    const stopAvailable = canAbort && !stopping && !loading && !configuring;
    const sendDisabled = inputDisabled || !input.value.trim();
    if (send.disabled !== sendDisabled) send.disabled = sendDisabled;
    stopButton.hidden = !stopAvailable;
    stopButton.disabled = !stopAvailable;
    const sendLabel = 'Send message to Friday';
    if (send.getAttribute('aria-label') !== sendLabel) send.setAttribute('aria-label', sendLabel);
    if (send.title !== 'Send message') send.title = 'Send message';
    const modelDisabled = loading || busy || configuring || !model.options.length;
    const thinkingDisabled = loading || busy || configuring || !thinking.options.length;
    if (model.disabled !== modelDisabled) model.disabled = modelDisabled;
    if (thinking.disabled !== thinkingDisabled) thinking.disabled = thinkingDisabled;
    const taskStages = { queued: 'Pi task queued', running: 'Pi is working', reviewing: 'Friday is reviewing', completed: 'Task complete', blocked: 'Task blocked', 'outcome-unknown': 'Task outcome unknown' };
    const taskReview = delegatedTask ? reviewStatusText(delegatedTask) : '';
    const taskStatus = delegatedTask && taskStages[delegatedTask.status]
      ? `${taskStages[delegatedTask.status]}${delegatedTask.label ? `: ${delegatedTask.label}` : ''}`
      : null;
    const activeTaskStatus = delegatedTask && ['queued', 'running', 'reviewing', 'outcome-unknown'].includes(delegatedTask.status);
    const failedQueueItem = [...optimistic].reverse().find((item) => item.status === 'failed');
    const failure = sendError || failedQueueItem?.error || '';
    const taskError = delegatedTask && ['blocked', 'outcome-unknown'].includes(delegatedTask.status)
      || ['failed', 'queue-full', 'interrupted'].includes(delegatedTask?.review?.stage);
    const statusText = failure ? 'Send failed' : loading ? 'Connecting…' : busy ? taskStatus || 'Friday is coordinating…' : configuring ? 'Updating settings…' : taskError ? taskStatus || 'Task error' : activeTaskStatus ? taskStatus : reachable ? 'Ready' : 'Reconnecting…';
    const statusState = failure || taskError ? 'error' : loading ? 'connecting' : busy || activeTaskStatus ? 'working' : configuring ? 'updating' : reachable ? 'ready' : 'reconnecting';
    if (status.textContent !== statusText) status.textContent = statusText;
    if (status.dataset.state !== statusState) status.dataset.state = statusState;
    const taskDetail = delegatedTask?.status === 'completed' ? delegatedTask.summary : delegatedTask?.summary || delegatedTask?.detail;
    const statusTitle = failure ? `Send failed: ${failure}` : taskStatus
      ? `${taskStatus}${taskReview ? ` · ${taskReview}` : ''}${taskDetail ? ` — ${taskDetail}` : ''}`
      : statusText;
    if (status.title !== statusTitle) status.title = statusTitle;
    renderTaskBoard();
    renderChatQueue();
  }

  function reviewStatusText(task) {
    const review = task.review;
    const labels = { queued: 'Review waiting', active: 'Review active', finished: 'Review finished', failed: 'Review failed', 'queue-full': 'Review queue full', interrupted: 'Review interrupted' };
    if (!review || !labels[review.stage]) return '';
    const at = review.stage === 'queued' ? review.queuedAt
      : review.stage === 'active' ? review.startedAt
        : review.stage === 'interrupted' ? review.interruptedAt : review.finishedAt;
    const elapsed = at ? Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000)) : null;
    const age = elapsed === null || !Number.isFinite(elapsed) ? '' : elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}m` : `${Math.floor(elapsed / 3600)}h`;
    return `${labels[review.stage]}${age ? ` · ${age}` : ''}${review.errorCode ? ` · ${review.errorCode}` : ''}`;
  }

  function applyRuntimeStatus(runtime) {
    busy = runtime.busy;
    delegatedTask = runtime.delegatedTask || null;
    delegatedTasks = Array.isArray(runtime.tasks) ? runtime.tasks : delegatedTask ? [delegatedTask] : [];
    canAbort = runtime.canAbort === true;
    applyState(runtime);
    renderContextUsage(runtime.contextUsage);
    updateControls();
  }

  function renderTaskBoard() {
    if (!taskBoard) return;
    const visible = delegatedTasks.slice(0, 8);
    if (taskPanel) taskPanel.hidden = visible.length === 0;
    const revision = JSON.stringify(visible.map((task) => [task.id, task.label, task.status, task.summary, task.detail, task.review, reviewStatusText(task)]));
    if (revision === taskBoardRevision) return;
    taskBoardRevision = revision;
    const scrollTop = taskBoard.scrollTop;
    const expanded = new Set(Array.from(taskBoard.children)
      .filter((row) => row.dataset.taskId && Array.from(row.children).some((child) => child.className === 'friday-task-details' && child.open))
      .map((row) => row.dataset.taskId));
    taskBoard.replaceChildren();
    for (const task of visible) {
      const row = document.createElement('div'); row.className = `friday-task-row ${task.status}`;
      row.dataset.taskId = task.id;
      const review = reviewStatusText(task);
      const heading = document.createElement('strong'); heading.textContent = `${task.label || 'Pi task'} · ${task.status}`;
      const taskDetail = task.status === 'completed' ? task.summary : task.summary || task.detail;
      row.append(heading);
      if (taskDetail) {
        const details = document.createElement('details'); details.className = 'friday-task-details'; details.open = expanded.has(task.id);
        const summary = document.createElement('summary');
        const summaryContent = document.createElement('span'); summaryContent.className = 'friday-task-summary-content';
        const preview = document.createElement('span'); preview.className = 'friday-task-preview'; preview.textContent = taskDetail; preview.title = taskDetail;
        summaryContent.append(preview);
        if (review) {
          const reviewStatus = document.createElement('span'); reviewStatus.className = 'friday-task-review-status'; reviewStatus.textContent = review; reviewStatus.title = review;
          summaryContent.append(reviewStatus);
        }
        const openLabel = document.createElement('span'); openLabel.className = 'friday-task-open-label'; openLabel.textContent = 'Full description below';
        summaryContent.append(openLabel);
        summary.append(summaryContent); details.append(summary);
        const full = document.createElement('p'); full.textContent = taskDetail; details.append(full);
        row.append(details);
      } else if (review) {
        const reviewStatus = document.createElement('span'); reviewStatus.className = 'friday-task-review-status'; reviewStatus.textContent = review; reviewStatus.title = review;
        row.append(reviewStatus);
      }
      taskBoard.append(row);
    }
    taskBoard.scrollTop = scrollTop;
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
    followsLatest = true;
    return true;
  }

  function scheduleScrollToLatest() {
    if (scrollFramePending) return;
    scrollFramePending = true;
    requestAnimationFrame(() => {
      scrollFramePending = false;
      if (followsLatest || scrollToLatestOnVisibleRender) {
        if (scrollToLatest()) scrollToLatestOnVisibleRender = false;
      }
    });
  }

  function observeLatestBlock() {
    if (!scrollResizeObserver) return;
    const latest = messages.lastElementChild;
    if (latest === observedLastBlock) return;
    if (observedLastBlock) scrollResizeObserver.unobserve(observedLastBlock);
    observedLastBlock = latest;
    if (latest) scrollResizeObserver.observe(latest);
  }

  if (typeof window.ResizeObserver === 'function') {
    scrollResizeObserver = new window.ResizeObserver(() => {
      if (followsLatest || scrollToLatestOnVisibleRender) scheduleScrollToLatest();
    });
    scrollResizeObserver.observe(messages);
  }
  messages.addEventListener('scroll', () => { followsLatest = nearBottom(); }, { passive: true });

  function updateMessage(article, message) {
    const className = `message ${message.role}`;
    if (article.className !== className) article.className = className;
    if (article.dataset.renderRole !== message.role) article.dataset.renderRole = message.role;
    const label = article.querySelector('.message-label');
    const labelText = message.role === 'user' ? 'You' : message.role === 'event' ? 'Friday · Task update' : 'Friday';
    if (label.textContent !== labelText) label.textContent = labelText;
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
    const content = document.createElement('div');
    content.className = 'message-content';
    body.append(label, content);
    article.append(body);
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
    optimistic.forEach((item) => {
      if (item.status !== 'failed') blocks.push({ type: 'message', key: `message:optimistic:${item.localId}`, message: { role: 'user', content: item.content } });
    });
    return blocks;
  }

  function render() {
    const stick = scrollToLatestOnVisibleRender || followsLatest || nearBottom();
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
      observeLatestBlock();
      if (scrollToLatestOnVisibleRender) scheduleScrollToLatest();
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
    observeLatestBlock();
    if (stick) {
      if (scrollToLatest()) scrollToLatestOnVisibleRender = false;
      scheduleScrollToLatest();
    }
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
    const runtimePromise = withStatus
      ? apiJson('/api/friday/status').then((runtime) => {
        if (started && version === lifecycleVersion) applyRuntimeStatus(runtime);
        return runtime;
      })
      : Promise.resolve(null);
    const [data, runtime] = await Promise.all([
      apiJson(historyUrl(fullHistory)),
      runtimePromise,
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
    optimistic = optimistic.filter((item) => {
      if (item.status === 'failed') return true;
      if (userMessages.length > item.after && userMessages[item.after]?.content === item.content) return false;
      return true;
    });
    if (runtime) {
      const jobs = new Map((Array.isArray(runtime.chatQueue) ? runtime.chatQueue : []).map((job) => [job.id, job]));
      optimistic = optimistic.filter((item) => {
        if (!item.id) return true;
        const job = jobs.get(item.id);
        if (!job) return true;
        item.status = job.status;
        item.position = job.position;
        item.error = job.error || null;
        if (['completed', 'cancelled'].includes(job.status)) return false;
        return true;
      });
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

  function schedulePoll(delay = POLL_INTERVAL_MS) {
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
    scheduleScrollToLatest();
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

  async function cancelQueuedMessage(item) {
    if (!item.id || item.status !== 'queued') return;
    try {
      await apiJson(`/api/friday/chat/${item.id}/cancel`, { method: 'POST' });
      optimistic = optimistic.filter((entry) => entry !== item);
      render();
      renderChatQueue();
      await sync({ withStatus: true });
    } catch (error) {
      if (!isAbort(error)) toast(error.message, 'error');
      try { await sync({ withStatus: true }); } catch { reachable = false; updateControls(); }
    }
  }

  stopButton.addEventListener('click', () => { void abortTurn(); });

  input.addEventListener('input', resizeInput);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    if (window.matchMedia?.('(max-width: 600px)').matches) return;
    event.preventDefault();
    if (!send.disabled) form.requestSubmit();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || loading || configuring) return;
    const item = { localId: ++optimisticSequence, content: message, after: history.filter((entry) => entry.role === 'user').length + optimistic.length, status: 'sending' };
    sendError = '';
    optimistic.push(item);
    input.value = '';
    resizeInput();
    render();
    scrollToLatest();
    scheduleScrollToLatest();
    updateControls();
    try {
      const response = await apiJson('/api/friday/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      item.id = response.id;
      item.status = response.status || 'queued';
      item.position = response.position;
      renderChatQueue();
    } catch (error) {
      optimistic = optimistic.filter((entry) => entry !== item);
      render();
      if (!input.value) input.value = message;
      resizeInput();
      sendError = error.message;
      updateControls();
      toast(error.message, 'error');
    } finally {
      try { await sync({ withStatus: true }); }
      catch { reachable = false; updateControls(); }
      schedulePoll(0);
      onHistory?.();
      input.focus();
    }
  });

  return { start, stop, pause: stopPolling, refreshTranscript, enterView };
}
