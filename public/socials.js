const status = document.querySelector('#gmail-status');
const inboxStatus = document.querySelector('#gmail-inbox-status');
const connect = document.querySelector('#gmail-connect');
const refresh = document.querySelector('#gmail-refresh');
const disconnect = document.querySelector('#gmail-disconnect');
const messageList = document.querySelector('#gmail-message-list');
const nextPage = document.querySelector('#gmail-next-page');
let pageToken = null;
let connected = false;
let loading = false;
const connectorState = {
  gmail: { configured: null, connecting: false, statusRequest: 0 },
  slack: { configured: null, connecting: false, statusRequest: 0 },
};
const API_TIMEOUT_MS = 15_000;

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...options, signal: controller.signal });
    const body = await response.json().catch((error) => {
      if (controller.signal.aborted) throw error;
      return {};
    });
    if (response.status === 401) {
      location.replace('/login?notice=login-required');
      throw new Error('Login required');
    }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Request timed out. Check the Friday connection and try again.');
    if (error instanceof TypeError) throw new Error('Could not reach Friday. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function startAuthorization({ provider, button, status, route, expectedUrl, state }) {
  return async () => {
    if (state.connecting) return;
    state.connecting = true;
    button.disabled = true;
    status.textContent = `Starting ${provider} authorization…`;
    try {
      const result = await api(route, { method: 'POST' });
      let url;
      try { url = new URL(result.authorizationUrl); } catch { throw new Error(`${provider} returned an invalid authorization URL. Check the Friday OAuth configuration.`); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || `${url.origin}${url.pathname}` !== expectedUrl) throw new Error(`${provider} returned an invalid authorization URL. Check the Friday OAuth configuration.`);
      location.assign(url.href);
    } catch (error) {
      status.textContent = error.message || `Could not start ${provider} authorization. Check the connection and retry.`;
    } finally {
      state.connecting = false;
      button.disabled = state.configured === false;
    }
  };
}

const jsonPost = (body = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function renderMessages(messages, append = false) {
  if (!append) messageList.replaceChildren();
  if (!messages.length && !append) {
    const empty = document.createElement('p');
    empty.className = 'empty-placeholder';
    empty.textContent = 'Your Inbox is empty.';
    messageList.append(empty);
    return;
  }
  for (const message of messages) {
    const article = document.createElement('article');
    article.className = `gmail-message${message.unread ? ' unread' : ''}`;
    const heading = document.createElement('div');
    heading.className = 'gmail-message-heading';
    const sender = document.createElement('strong');
    sender.textContent = message.from || 'Unknown sender';
    const date = document.createElement('time');
    date.textContent = message.date || '';
    heading.append(sender, date);
    const subject = document.createElement('h3');
    subject.textContent = message.subject;
    article.append(heading, subject);
    messageList.append(article);
  }
}

async function loadMessages({ append = false } = {}) {
  if (!connected || loading) return;
  loading = true;
  refresh.disabled = true;
  nextPage.disabled = true;
  inboxStatus.textContent = 'Loading Inbox metadata…';
  try {
    const query = new URLSearchParams();
    if (append && pageToken) query.set('pageToken', pageToken);
    const result = await api(`/api/socials/gmail/messages${query.size ? `?${query}` : ''}`);
    renderMessages(result.messages, append);
    pageToken = result.nextPageToken;
    nextPage.hidden = !pageToken;
    inboxStatus.textContent = `${result.messages.length} Inbox message${result.messages.length === 1 ? '' : 's'} loaded.`;
  } catch (error) {
    inboxStatus.textContent = error.message;
    if (!append) messageList.replaceChildren();
  } finally {
    loading = false;
    refresh.disabled = false;
    nextPage.disabled = false;
  }
}

async function loadStatus() {
  const state = connectorState.gmail;
  const request = ++state.statusRequest;
  try {
    const result = await api('/api/socials/gmail/status');
    if (request !== state.statusRequest) return;
    if (typeof result.configured !== 'boolean' || typeof result.connected !== 'boolean') throw new Error('Unexpected Gmail connection status. Refresh and retry.');
    state.configured = result.configured;
    connected = result.connected;
    connect.hidden = connected;
    connect.disabled = !result.configured || state.connecting;
    refresh.hidden = !connected;
    disconnect.hidden = !connected;
    document.body.dataset.gmailAddress = result.email || '';
    if (connected) {
      status.textContent = `Connected as ${result.email}`;
      inboxStatus.textContent = 'Open or refresh Socials to load Inbox metadata.';
    } else if (!result.configured) {
      status.textContent = 'Not configured. Set FRIDAY_GMAIL_CLIENT_ID, FRIDAY_GMAIL_CLIENT_SECRET, and FRIDAY_GMAIL_REDIRECT_URI on the Friday host, then restart.';
      inboxStatus.textContent = 'Configure and connect Gmail in System Settings → Connections to view Inbox metadata.';
      connect.title = 'Gmail OAuth must be configured on the Friday host.';
    } else {
      status.textContent = 'Not connected';
      inboxStatus.textContent = 'Connect Gmail in System Settings → Connections to view Inbox metadata.';
    }
  } catch (error) {
    if (request !== state.statusRequest) return;
    status.textContent = error.message;
    inboxStatus.textContent = `Could not check Gmail connection. ${error.message}`;
    connect.hidden = connected;
    connect.disabled = state.connecting;
    refresh.hidden = !connected;
    disconnect.hidden = !connected;
  }
}

connect.addEventListener('click', startAuthorization({
  provider: 'Google', button: connect, status, state: connectorState.gmail,
  route: '/api/socials/gmail/connect', expectedUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
}));

refresh.addEventListener('click', () => { pageToken = null; void loadMessages(); });
nextPage.addEventListener('click', () => void loadMessages({ append: true }));
disconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect Gmail and remove Friday’s saved Gmail credentials?')) return;
  disconnect.disabled = true;
  try {
    await api('/api/socials/gmail/disconnect', { method: 'POST' });
    connected = false;
    pageToken = null;
    messageList.replaceChildren();
    await loadStatus();
  } catch (error) { status.textContent = error.message; }
  finally { disconnect.disabled = false; }
});

document.addEventListener('friday:feature-change', (event) => {
  if (event.detail === 'socials') {
    if (connected) void loadMessages();
    if (slackConnected) void loadSlackChannels();
  }
});

const slackStatus = document.querySelector('#slack-status');
const slackChannelsStatus = document.querySelector('#slack-channels-status');
const slackConnect = document.querySelector('#slack-connect');
const slackRefresh = document.querySelector('#slack-refresh-channels');
const slackDisconnect = document.querySelector('#slack-disconnect');
const slackSave = document.querySelector('#slack-save-channels');
const slackChannelList = document.querySelector('#slack-channel-list');
let slackConnected = false;
let slackSelectedIds = [];

function renderSlackChannels(channels) {
  slackChannelList.replaceChildren();
  if (!channels.length) { const empty = document.createElement('p'); empty.className = 'empty-placeholder'; empty.textContent = 'No public channels are available.'; slackChannelList.append(empty); return; }
  for (const channel of channels) {
    const label = document.createElement('label'); label.className = 'gmail-message';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = channel.id; checkbox.checked = slackSelectedIds.includes(channel.id); checkbox.setAttribute('aria-label', `Select #${channel.name}`);
    const name = document.createElement('strong'); name.textContent = `#${channel.name}`;
    label.append(checkbox, name); slackChannelList.append(label);
  }
}

async function loadSlackChannels() {
  if (!slackConnected) return;
  slackRefresh.disabled = true; slackChannelsStatus.textContent = 'Loading public channels…';
  try {
    const [channelResult, statusResult] = await Promise.all([api('/api/socials/slack/channels'), api('/api/socials/slack/status')]);
    slackSelectedIds = statusResult.selectedChannels || [];
    renderSlackChannels(channelResult.channels || []);
    slackStatus.textContent = `Connected to ${statusResult.workspace?.name || 'Slack workspace'}`;
    slackChannelsStatus.textContent = `${slackSelectedIds.length} public channel${slackSelectedIds.length === 1 ? '' : 's'} selected.`;
  } catch (error) { slackChannelsStatus.textContent = error.message; }
  finally { slackRefresh.disabled = false; }
}

async function loadSlackStatus() {
  const state = connectorState.slack;
  const request = ++state.statusRequest;
  try {
    const result = await api('/api/socials/slack/status');
    if (request !== state.statusRequest) return;
    if (typeof result.configured !== 'boolean' || typeof result.connected !== 'boolean') throw new Error('Unexpected Slack connection status. Refresh and retry.');
    state.configured = result.configured;
    slackConnected = result.connected; slackSelectedIds = result.selectedChannels || [];
    slackConnect.hidden = slackConnected; slackConnect.disabled = !result.configured || state.connecting;
    slackRefresh.hidden = !slackConnected; slackDisconnect.hidden = !slackConnected; slackSave.hidden = !slackConnected;
    if (slackConnected) {
      slackStatus.textContent = `Connected to ${result.workspace?.name || 'Slack workspace'}`;
      slackChannelsStatus.textContent = `${slackSelectedIds.length} public channel${slackSelectedIds.length === 1 ? '' : 's'} selected. Refresh to manage channels.`;
    } else {
      slackChannelList.replaceChildren();
      slackStatus.textContent = result.configured ? 'Not connected' : 'Not configured. Set FRIDAY_SLACK_CLIENT_ID, FRIDAY_SLACK_CLIENT_SECRET, and FRIDAY_SLACK_REDIRECT_URI on the Friday host.';
      slackChannelsStatus.textContent = 'Connect Slack in System Settings → Connections to select public channels.';
    }
  } catch (error) {
    if (request !== state.statusRequest) return;
    slackStatus.textContent = error.message;
    slackChannelsStatus.textContent = `Could not check Slack connection. ${error.message}`;
    slackConnect.hidden = slackConnected;
    slackConnect.disabled = state.connecting;
    slackRefresh.hidden = !slackConnected; slackDisconnect.hidden = !slackConnected; slackSave.hidden = !slackConnected;
  }
}
slackConnect.addEventListener('click', startAuthorization({
  provider: 'Slack', button: slackConnect, status: slackStatus, state: connectorState.slack,
  route: '/api/socials/slack/connect', expectedUrl: 'https://slack.com/oauth/v2/authorize',
}));
slackRefresh.addEventListener('click', () => void loadSlackChannels());
slackSave.addEventListener('click', async () => {
  const channelIds = [...slackChannelList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  slackSave.disabled = true;
  try { const result = await api('/api/socials/slack/selected-channels', jsonPost({ channelIds })); slackSelectedIds = result.channels; slackChannelsStatus.textContent = `${slackSelectedIds.length} public channel${slackSelectedIds.length === 1 ? '' : 's'} selected.`; renderSlackChannels((await api('/api/socials/slack/channels')).channels || []); }
  catch (error) { slackChannelsStatus.textContent = error.message; }
  finally { slackSave.disabled = false; }
});
slackDisconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect Slack and remove Friday’s saved Slack credentials and channel selections?')) return;
  slackDisconnect.disabled = true;
  try { await api('/api/socials/slack/disconnect', { method: 'POST' }); slackConnected = false; slackSelectedIds = []; slackChannelList.replaceChildren(); await loadSlackStatus(); }
  catch (error) { slackStatus.textContent = error.message; }
  finally { slackDisconnect.disabled = false; }
});

const callbackUrl = new URL(location.href);
if (callbackUrl.searchParams.get('gmail') === 'connected') {
  status.textContent = 'Gmail connected.';
  callbackUrl.searchParams.delete('gmail');
  history.replaceState(null, '', callbackUrl);
}
void Promise.all([loadStatus(), loadSlackStatus()]).then(() => {
  const activeFeature = document.querySelector('[data-feature][aria-current="page"]')?.dataset.feature;
  if (activeFeature === 'socials') {
    if (connected) void loadMessages();
    if (slackConnected) void loadSlackChannels();
  }
});
