export function createFridayChat({ apiJson, renderMarkdown, toast }) {
  const messages = document.querySelector('#friday-messages');
  const form = document.querySelector('#friday-form');
  const input = document.querySelector('#friday-message');
  const send = document.querySelector('#friday-send');
  const model = document.querySelector('#friday-model');
  const thinking = document.querySelector('#friday-thinking-level');
  const status = document.querySelector('#friday-status');
  const announcement = document.querySelector('#friday-announcement');

  let history = [];
  let optimistic = null;
  let busy = false;
  let canAbort = false;
  let stopping = false;
  let loading = false;
  let configuring = false;
  let currentModel = '';
  let currentThinking = 'off';
  let started = false;
  let source = null;
  let reconnectTimer = null;
  let refreshTimer = null;
  let fallbackTimer = null;
  let syncing = false;
  let needsSync = false;
  let connectionVersion = 0;
  let lifecycleVersion = 0;
  let reachable = false;

  function updateControls() {
    input.disabled = loading || busy || configuring;
    const stopAvailable = canAbort && !stopping && !loading && !configuring;
    send.disabled = stopAvailable ? false : input.disabled || !input.value.trim();
    const sendMode = stopAvailable ? 'stop' : 'send';
    if (send.dataset.mode !== sendMode) {
      send.dataset.mode = sendMode;
      send.innerHTML = stopAvailable
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-7-5 14-2.5-5.5L5 12Z"/></svg>';
    }
    send.classList.toggle('stop', stopAvailable);
    send.setAttribute('aria-label', stopAvailable ? 'Stop Friday response' : 'Send message to Friday');
    send.title = stopAvailable ? 'Stop response' : 'Send message';
    model.disabled = loading || busy || configuring || !model.options.length;
    thinking.disabled = loading || busy || configuring || !thinking.options.length;
    status.textContent = loading ? 'Connecting…' : busy ? 'Friday is thinking…' : configuring ? 'Updating settings…' : reachable ? 'Ready' : 'Reconnecting…';
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

  function makeMessage(message) {
    const article = document.createElement('article');
    article.className = `message ${message.role}`;
    article.messageKey = JSON.stringify(message);
    const body = document.createElement('div');
    body.className = 'message-body';
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = message.role === 'user' ? 'You' : 'Friday';
    const content = document.createElement('div');
    content.className = 'message-content';
    renderMarkdown(content, message.content);
    body.append(label, content);
    if (message.role === 'user') article.append(body);
    else {
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = 'F';
      avatar.setAttribute('aria-hidden', 'true');
      article.append(avatar, body);
    }
    return article;
  }

  function makeToolGroup(records) {
    const group = document.createElement('details');
    group.className = 'tool-group';
    const summary = document.createElement('summary');
    const counts = new Map();
    for (const { call } of records) counts.set(call.name || 'tool', (counts.get(call.name || 'tool') || 0) + 1);
    const names = [...counts].map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ''}`).join(', ');
    const errors = records.filter(({ result }) => result?.isError).length;
    summary.textContent = `${records.length} tool call${records.length === 1 ? '' : 's'} · ${names}${errors ? ` · ${errors} failed` : ''}`;
    const list = document.createElement('div');
    list.className = 'tool-group-list';
    records.forEach(({ call, result }) => {
      const entry = document.createElement('details');
      entry.className = `system-entry${result?.isError ? ' error' : ''}`;
      const title = document.createElement('summary');
      title.textContent = `${call.name || 'tool'} · ${result ? result.isError ? 'error' : 'complete' : 'running'}`;
      entry.append(title);
      const output = [`Call\n${JSON.stringify(call.arguments || {}, null, 2)}`];
      if (result) output.push(`Result\n${result.content || '(empty)'}`);
      const pre = document.createElement('pre');
      pre.textContent = output.join('\n\n');
      entry.append(pre);
      list.append(entry);
    });
    group.append(summary, list);
    return group;
  }

  function historyBlocks() {
    const blocks = [];
    const calls = new Map();
    for (const message of history) {
      if (message.role === 'tool') {
        const record = calls.get(message.toolCallId);
        if (record) record.result = message;
        else blocks.push({ type: 'tools', records: [{ call: { name: message.toolName || 'tool', arguments: {} }, result: message }] });
        continue;
      }
      if (!['user', 'assistant'].includes(message.role)) continue;
      if (message.content) blocks.push({ type: 'message', message });
      if (message.role === 'assistant' && message.toolCalls?.length) {
        const records = message.toolCalls.map((call) => ({ call, result: null }));
        blocks.push({ type: 'tools', records });
        for (const record of records) if (record.call.id) calls.set(record.call.id, record);
      }
    }
    if (optimistic) blocks.push({ type: 'message', message: { role: 'user', content: optimistic.content } });
    return blocks;
  }

  function render() {
    const stick = nearBottom();
    const blocks = historyBlocks();
    if (!blocks.length) {
      if (!messages.querySelector('.welcome')) {
        const welcome = document.createElement('div');
        welcome.className = 'welcome';
        const title = document.createElement('h2');
        title.textContent = 'Good to see you.';
        const copy = document.createElement('p');
        copy.textContent = 'Friday can read and edit files or run shell commands in its workspace. These tools use the Friday host account and are not sandboxed.';
        welcome.append(title, copy);
        messages.replaceChildren(welcome);
      }
      return;
    }

    if (messages.querySelector('.welcome')) messages.replaceChildren();
    const current = [...messages.children];
    blocks.forEach((block, index) => {
      const key = JSON.stringify(block);
      if (current[index]?.messageKey === key) return;
      const item = block.type === 'tools' ? makeToolGroup(block.records) : makeMessage(block.message);
      item.messageKey = key;
      if (current[index]) current[index].replaceWith(item);
      else messages.append(item);
    });
    for (let index = blocks.length; index < current.length; index += 1) current[index].remove();
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  async function sync({ withStatus = false } = {}) {
    if (syncing) {
      needsSync = true;
      return;
    }
    syncing = true;
    const version = lifecycleVersion;
    try {
      const [data, runtime] = await Promise.all([
        apiJson('/api/friday/history'),
        withStatus ? apiJson('/api/friday/status') : null,
      ]);
      if (!started || version !== lifecycleVersion) return;
      reachable = true;
      const previousReply = [...history].reverse().find((item) => item.role === 'assistant')?.content;
      history = data.messages;
      const latestReply = [...history].reverse().find((item) => item.role === 'assistant')?.content;
      if (!loading && latestReply && latestReply !== previousReply) {
        announcement.textContent = `Friday: ${latestReply}`;
      }
      const userMessages = history.filter((item) => item.role === 'user');
      if (optimistic && userMessages.length > optimistic.after && userMessages[optimistic.after]?.content === optimistic.content) {
        optimistic = null;
      }
      if (runtime) {
        busy = runtime.busy;
        canAbort = runtime.canAbort === true;
        applyState(runtime);
      }
      render();
      updateControls();
    } finally {
      syncing = false;
      if (needsSync && started) {
        needsSync = false;
        void sync({ withStatus: true }).catch(() => scheduleFallback());
      }
    }
  }

  function queueRefresh(delay = 500) {
    if (refreshTimer || !started) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void sync({ withStatus: true }).catch(() => {
        reachable = false;
        updateControls();
        if (source?.readyState === 1) queueRefresh(3_000);
        else scheduleFallback();
      });
    }, delay);
  }

  function scheduleFallback() {
    clearTimeout(fallbackTimer);
    if (!started || source?.readyState === 1) return;
    fallbackTimer = setTimeout(async () => {
      try { await sync({ withStatus: true }); }
      catch { reachable = false; updateControls(); }
      scheduleFallback();
    }, busy ? 3_000 : 30_000);
  }

  function connect() {
    if (!started || !('EventSource' in window)) {
      scheduleFallback();
      return;
    }
    const version = ++connectionVersion;
    source?.close();
    source = null;
    clearTimeout(reconnectTimer);
    void apiJson('/api/friday/events/token', { method: 'POST' }).then(({ token }) => {
      if (!started || version !== connectionVersion) return;
      const stream = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      source = stream;
      stream.onopen = () => {
        if (source !== stream) return;
        clearTimeout(fallbackTimer);
        void sync({ withStatus: true }).catch(() => queueRefresh(3_000));
      };
      stream.addEventListener('runtime', (event) => {
        if (source !== stream) return;
        try {
          const data = JSON.parse(event.data);
          busy = data.busy === true;
          canAbort = data.canAbort === true;
          updateControls();
          if (data.kind !== 'ready') queueRefresh();
          if (data.kind === 'status' && ['model change', 'thinking level change'].includes(data.operation)) {
            void loadOptions().catch(() => {}); // A later status event retries after the operation finishes.
          }
        } catch { /* Ignore malformed notifications; history remains authoritative. */ }
      });
      stream.onerror = () => {
        if (source !== stream) return;
        stream.close();
        source = null;
        scheduleFallback();
        reconnectTimer = setTimeout(connect, 3_000);
      };
    }).catch(() => {
      if (version !== connectionVersion || !started) return;
      scheduleFallback();
      reconnectTimer = setTimeout(connect, 3_000);
    });
  }

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
      scheduleFallback();
    }
    try {
      await loadOptions();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      loading = false;
      updateControls();
      connect();
    }
  }

  function stop() {
    started = false;
    lifecycleVersion += 1;
    connectionVersion += 1;
    source?.close();
    source = null;
    clearTimeout(reconnectTimer);
    clearTimeout(refreshTimer);
    clearTimeout(fallbackTimer);
    reconnectTimer = refreshTimer = fallbackTimer = null;
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
      catch { reachable = false; scheduleFallback(); }
      stopping = false;
      updateControls();
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
      catch {
        reachable = false;
        updateControls();
        if (source?.readyState === 1) queueRefresh(3_000);
        else scheduleFallback();
      }
      if (!source || source.readyState !== 1) scheduleFallback();
      input.focus();
    }
  });

  return { start, stop };
}
