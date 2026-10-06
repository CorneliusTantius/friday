const status = document.querySelector('#gmail-status');
const connect = document.querySelector('#gmail-connect');
const refresh = document.querySelector('#gmail-refresh');
const disconnect = document.querySelector('#gmail-disconnect');
const messageList = document.querySelector('#gmail-message-list');
const nextPage = document.querySelector('#gmail-next-page');
let pageToken = null;
let connected = false;
let loading = false;

async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.replace('/login?notice=login-required');
    throw new Error('Login required');
  }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

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
  status.textContent = 'Loading Inbox metadata…';
  try {
    const query = new URLSearchParams();
    if (append && pageToken) query.set('pageToken', pageToken);
    const result = await api(`/api/socials/gmail/messages${query.size ? `?${query}` : ''}`);
    renderMessages(result.messages, append);
    pageToken = result.nextPageToken;
    nextPage.hidden = !pageToken;
    status.textContent = `Connected as ${document.body.dataset.gmailAddress || 'your Google account'}`;
  } catch (error) {
    status.textContent = error.message;
    if (!append) messageList.replaceChildren();
  } finally {
    loading = false;
    refresh.disabled = false;
    nextPage.disabled = false;
  }
}

async function loadStatus() {
  try {
    const result = await api('/api/socials/gmail/status');
    connected = result.connected;
    connect.hidden = connected;
    connect.disabled = !result.configured;
    refresh.hidden = !connected;
    disconnect.hidden = !connected;
    document.body.dataset.gmailAddress = result.email || '';
    if (connected) {
      status.textContent = `Connected as ${result.email}`;
      await loadMessages();
    } else if (!result.configured) {
      status.textContent = 'Not configured. Set FRIDAY_GMAIL_CLIENT_ID, FRIDAY_GMAIL_CLIENT_SECRET, and FRIDAY_GMAIL_REDIRECT_URI on the Friday host, then restart.';
      connect.title = 'Gmail OAuth must be configured on the Friday host.';
    } else {
      status.textContent = 'Not connected';
    }
  } catch (error) { status.textContent = error.message; }
}

connect.addEventListener('click', async () => {
  connect.disabled = true;
  status.textContent = 'Starting Google authorization…';
  try {
    const result = await api('/api/socials/gmail/connect', { method: 'POST' });
    location.assign(result.authorizationUrl);
  } catch (error) {
    status.textContent = error.message;
    connect.disabled = false;
  }
});

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

document.querySelectorAll('[data-feature="socials"]').forEach((button) => button.addEventListener('click', () => {
  if (connected) void loadMessages();
}));

const callbackUrl = new URL(location.href);
if (callbackUrl.searchParams.get('gmail') === 'connected') {
  status.textContent = 'Gmail connected.';
  callbackUrl.searchParams.delete('gmail');
  history.replaceState(null, '', callbackUrl);
}
void loadStatus();
