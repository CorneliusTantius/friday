import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runBrowserCheck } from '../test-support/mockup-browser.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const sessionCards = await readFile(new URL('../public/friday-pi-session-cards.js', import.meta.url), 'utf8');
const chat = await readFile(new URL('../public/friday-chat.js', import.meta.url), 'utf8');
const localCalendar = await readFile(new URL('../public/local-calendar.js', import.meta.url), 'utf8');
const calendarView = await readFile(new URL('../public/calendar-view.js', import.meta.url), 'utf8');
const socials = await readFile(new URL('../public/socials.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const login = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');

test('new Pi sessions offer a generated staff alias that saves only on explicit user action', () => {
  assert.match(html, /id="pi-staff-name-suggestion"[^>]*hidden/);
  assert.match(html, /id="pi-regenerate-staff-name"[^>]*>Generate another/);
  assert.match(html, /id="pi-save-staff-name"[^>]*>Save alias/);
  assert.match(app, /sessionStorage\.setItem\('friday-new-pi-run-id', data\.runId\)/);
  assert.match(app, /await suggestPiStaffName\(newRunId\)/);
  assert.match(app, /apiJson\(`\/api\/friday\/pi-conversations\/\$\{encodeURIComponent\(session\.runId\)\}\/profile`/);
  assert.match(app, /if \(!session \|\| session\.displayName\)/);
  assert.match(sessionCards, /function generateStaffDisplayName\(sessions, excludeRunId = null\)/);
  assert.match(sessionCards, /Generate suggestion/);
});

test('public workspace UI contract has every feature, form, and shell integration', () => {
  for (const id of ['friday-feature','pi-feature','files-feature','dashboard-feature','repos-feature','notes-feature','finances-feature','socials-feature','calendar-feature','settings-feature','friday-form','friday-chat-queue','friday-stop','chat-form','file-save','finance-form','clone-repo-form','workspace-sidebar','assistant-rail','shell-command-dialog','shell-command-input']) {
    assert.equal((html.match(new RegExp(`\\bid=["']${id}["']`, 'g')) || []).length, 1, `expected one #${id}`);
  }
  assert.match(html, /data-shell-drawer="assistant"/);
  assert.match(html, /data-shell-drawer="sidebar"/);
  assert.doesNotMatch(html, /Host Online|Host online|connection-dot|connection-label|topbar-status/);
  assert.doesNotMatch(app, /setConnection|connection-dot|connection-label/);
  assert.doesNotMatch(css, /\.connection-dot|\.topbar-status/);
  assert.match(app, /initializeWorkspaceShell/);
  assert.match(app, /createFridayChat/);
  assert.match(app, /const fridayEntry = name === 'friday' \? fridayChat\.enterView\(\) : null/);
  assert.match(app, /Promise\.all\(\[fridayChat\.start\(\), fridayEntry,/);
  assert.match(app, /onEnter: refreshFridayAgentViewData/);
  assert.match(app, /apiJson\('\/api\/friday\/pi-conversations'/);
  assert.match(html, /id="friday-task-board"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="friday-chat-queue"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(chat, /Cancel queued message/);
  assert.match(chat, /function cancelQueuedMessage/);
  assert.match(chat, /runtime\.chatQueue/);
  assert.match(css, /\.pi-layout \{ grid-template-columns:260px minmax\(0,1fr\); \}/);
  assert.match(css, /\.pi-layout \{ grid-template-columns:225px minmax\(0,1fr\); \}/);
  assert.match(css, /@media \(max-width:1000px\)[\s\S]*\.pi-layout,\.files-layout,\.notes-layout \{ display:block; \}/);
  assert.match(css, /@media \(max-width:1000px\)[\s\S]*\.pi-sidebar[^}]*width:min\(84vw,310px\)/);
  assert.match(sessionCards, /Edit staff profile/);
  assert.match(sessionCards, /Expertise \(one per line\)/);
  assert.match(sessionCards, /Responsibilities \(one per line\)/);
  assert.match(sessionCards, /Repo affinity \(staff-fit metadata; one per line\)/);
  assert.match(sessionCards, /Workload: \$\{session\.workload\?\.openTasks/);
  assert.match(chat, /Friday · Task update/);
  const pollRefresh = app.slice(app.indexOf('async function pollHistory'), app.indexOf('function startPolling'));
  assert.match(pollRefresh, /loadHistory\(\{ limit: data\.busy \? 10 : null \}\)/);
  assert.match(pollRefresh, /loadSessions\(elements\.workspace\.value, \{ quiet: true \}\)/);
  assert.match(app, /const activePollInterval = 2_000/);
  assert.match(app, /const idlePollInterval = 15_000/);
  assert.match(app, /if \(startPiPolling\) startPolling\(0\)/);
  assert.match(app, /fridayPiConversationPollTimer = setTimeout/);
  assert.doesNotMatch(app, /EventSource|\/api\/events/);
  assert.match(app, /function scheduleFridaySessionListPolling/);
  assert.match(app, /fridaySessionsRefreshAgain/);
  assert.match(chat, /function schedulePoll/);
  assert.match(chat, /document\.addEventListener\('visibilitychange'/);
  assert.doesNotMatch(chat, /EventSource|events\/token/);
  assert.match(sessionCards, /session\.opening \? 'Opening'/);
  assert.match(sessionCards, /session\.running \? 'Open' : 'Saved'/);
  assert.match(sessionCards, /Working.*queued/);
  assert.match(app, /activeFridaySession = id; await fridayChat\.enterView\(\);/);
  assert.match(app, /openAssistant\(\) \{ open\(assistant\); void fridayChat\.enterView\(\)\.catch/);
  assert.match(app, /fridayChat\.enterView\(\)\.catch/);
  assert.match(app, /\['socials', \$\('#socials-feature'\)\]/);
  assert.match(app, /\['calendar', \$\('#calendar-feature'\)\]/);
  assert.match(html, /data-feature="socials"/);
  assert.match(html, /nav-group-title workspace-nav-heading">Workspace<\/span>/);
  assert.doesNotMatch(html, /nav-group-title workspace-nav-heading">Agents<\/span>/);
  const workspaceNav = html.slice(html.indexOf('nav-group-title workspace-nav-heading">Workspace'), html.indexOf('nav-group-title workspace-nav-heading">Your space'));
  const yourSpaceNav = html.slice(html.indexOf('nav-group-title workspace-nav-heading">Your space'), html.indexOf('nav-group-title workspace-nav-heading">System'));
  for (const feature of ['friday', 'pi', 'repos', 'calendar', 'socials']) assert.match(workspaceNav, new RegExp(`data-feature="${feature}"`));
  assert.doesNotMatch(yourSpaceNav, /data-feature="calendar"|data-feature="socials"/);
  assert.match(html, /data-feature="calendar"/);
  const socialsPage = html.slice(html.indexOf('id="socials-feature"'), html.indexOf('id="calendar-feature"'));
  const calendarPage = html.slice(html.indexOf('id="calendar-feature"'), html.indexOf('id="settings-feature"'));
  const connections = html.slice(html.indexOf('class="settings-group connections-settings-group"'), html.indexOf('class="settings-group friday-settings-group"'));
  for (const id of ['gmail-connect', 'gmail-status', 'gmail-disconnect', 'slack-connect', 'slack-status', 'slack-disconnect']) {
    assert.equal((html.match(new RegExp(`\\bid="${id}"`, 'g')) || []).length, 1, `#${id} exists only once`);
    assert.ok(connections.includes(`id="${id}"`), `#${id} is in System Settings Connections`);
  }
  assert.match(connections, /Authorize Gmail with Google/);
  assert.match(connections, /Google access and refresh tokens stay in private files on this host/);
  assert.match(connections, /Authorize Slack workspace/);
  assert.match(connections, /workspace-admin approval may be required/);
  assert.match(connections, /Slack bot token privately on this host/);
  assert.match(connections, /does not sign you in to Friday/);
  assert.doesNotMatch(socialsPage, /gmail-connect|gmail-status|gmail-disconnect|slack-connect|slack-status|slack-disconnect|calendar-connect|calendar-status|calendar-event-list/);
  assert.match(socialsPage, /gmail-inbox-status[\s\S]*gmail-message-list[\s\S]*slack-channels-status[\s\S]*slack-channel-list/);
  for (const id of ['calendar-month-grid', 'calendar-month-days', 'calendar-mobile-date', 'calendar-mobile-agenda', 'calendar-event-form', 'calendar-title', 'calendar-start', 'calendar-end', 'calendar-event-list']) assert.match(calendarPage, new RegExp(`id="${id}"`));
  assert.doesNotMatch(calendarPage, /Google|Authorize|Connect Calendar/);
  assert.match(localCalendar, /api\/calendar\/events/);
  assert.match(localCalendar, /method: editingId \? 'PUT' : 'POST'/);
  assert.match(localCalendar, /method: 'DELETE'/);
  assert.match(html, /calendar-month-navigation[\s\S]*aria-label="Previous month"[\s\S]*calendar-today[\s\S]*aria-label="Next month"/);
  assert.match(html, /<table id="calendar-month-grid"[\s\S]*scope="col"[\s\S]*id="calendar-month-days"/);
  assert.match(localCalendar, /countEventsByDay\([\s\S]*buildMonthDays\([\s\S]*aria-pressed/);
  assert.match(localCalendar, /selectedEvents = events\.filter/);
  assert.match(localCalendar, /monthDays\.querySelector\(/);
  assert.match(localCalendar, /function beginCreate\(\)/);
  assert.match(calendarView, /export function shiftMonth/);
  assert.ok(server.includes('href="/?feature=settings"'), 'Gmail and Slack OAuth callbacks return to Settings');
  assert.ok(server.includes("join(paths.dataDir, 'calendar', 'events.json')"), 'local events are stored under private Friday data');
  assert.match(socials, /friday:feature-change/);
  assert.match(socials, /api\/socials\/gmail\/messages/);
  assert.doesNotMatch(socials, /message\.snippet/);
  assert.match(socials, /api\/socials\/gmail\/status/);
  assert.match(chat, /apiJson\('\/api\/friday\/chat'/);
  for (const route of ['/styles.css', '/app.js']) assert.ok(html.includes(`"${route}"`));
  assert.ok(app.includes("import('./friday-chat.js')"));
  assert.match(css, /--bg:\s*#0b0e11;/);
  assert.match(css, /--accent:\s*#72d9e5;/);
  for (const variable of ['display', 'mono', 'purple']) assert.match(css, new RegExp(`--${variable}:`));
  assert.match(css, /--border:\s*rgba\(/);
  assert.match(css, /--radius-sm:\s*8px/);
  assert.match(css, /--radius:\s*14px/);
  assert.match(css, /:focus-visible\s*\{\s*outline:2px solid var\(--accent\)/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)[\s\S]*\.feature:hover,button:active:not\(:disabled\) \{ transform:none !important; \}/);
  assert.match(css, /@keyframes view-fade \{ from \{ opacity:0; transform:translateY\(4px\)/);
});

test('Friday right sidebar uses 35% of desktop layout while retaining mobile drawers', () => {
  assert.match(html, /id="friday-pi-sidebar"/);
  assert.match(css, /\.friday-layout \{ grid-template-columns:220px minmax\(400px,1fr\) minmax\(320px,35%\); \}/);
  assert.match(css, /@media \(max-width:1390px\)[\s\S]*\.friday-layout \{ grid-template-columns:210px minmax\(400px,1fr\) minmax\(320px,35%\); \}/);
  const tablet = css.slice(css.indexOf('@media (max-width:1170px)'), css.indexOf('@media (max-width:1000px)'));
  assert.match(tablet, /\.friday-layout \{ grid-template-columns:220px minmax\(0,1fr\); \}/);
  assert.match(tablet, /\.friday-pi-sidebar \{ position:fixed;[\s\S]*width:min\(84vw,310px\)/);
  const mobile = css.slice(css.indexOf('@media (max-width:800px)'));
  assert.match(mobile, /\.friday-layout \{ display:block; \}/);
});

test('staff cards expose per-session repository visibility separately from repo affinity', () => {
  assert.match(app, /createFridayPiSessionCards/);
  assert.match(sessionCards, /Visible repositories/);
  assert.match(sessionCards, /session\.availableRepositories/);
  assert.match(sessionCards, /session\.visibleRepositories/);
  assert.match(sessionCards, /friday-repo-visibility/);
  assert.match(sessionCards, /not a filesystem sandbox/);
  assert.match(sessionCards, /Repo affinity \(staff-fit metadata; one per line\)/);
});

test('Friday sidebar groups scrollable conversations above tasks with expandable one-line details', () => {
  const sidebarStart = html.indexOf('<aside class="context-sidebar friday-pi-sidebar"');
  const sidebarEnd = html.indexOf('</aside>', sidebarStart);
  const sidebar = html.slice(sidebarStart, sidebarEnd);
  const conversationsHeading = sidebar.indexOf('<span>Conversations</span>');
  const conversations = sidebar.indexOf('id="friday-pi-session-list"');
  const tasksHeading = sidebar.indexOf('id="friday-task-heading"');
  const tasks = sidebar.indexOf('id="friday-task-board"');
  assert.ok(conversationsHeading >= 0 && conversationsHeading < conversations && conversations < tasksHeading && tasksHeading < tasks);
  const chatColumn = html.slice(html.indexOf('<div class="app friday-app">'), sidebarStart);
  assert.doesNotMatch(chatColumn, /id="friday-task-board"/);
  assert.match(css, /\.friday-pi-sidebar > \.session-list \{ flex:1 1 0; min-height:5rem; \}/);
  assert.match(css, /\.friday-task-board \{[^}]*overflow:auto/);
  assert.match(css, /\.friday-task-details summary \{[^}]*text-overflow:ellipsis; white-space:nowrap/);
  assert.match(css, /\.friday-task-panel\[hidden\] \{ display:none; \}/);
  assert.match(css, /@media \(max-width:1170px\)[\s\S]*\.friday-pi-sidebar \.mobile-close/);
});

test('settings start collapsed and Files and Notes expose accessible code/tree navigation', () => {
  assert.match(html, /<details class="settings-group friday-settings-group">/);
  assert.match(html, /<details class="settings-group pi-settings-group">/);
  assert.doesNotMatch(html, /<details open class="settings-group/);
  assert.match(html, /<nav id="note-list" class="file-list" aria-label="Notes">/);
  assert.match(app, /className = 'notes-tree-folder-label'/);
  assert.match(css, /\.notes-tree \.file-item \{ font-size: 12px; \}/, 'only note-tree entries use the smaller label size');
  assert.match(app, /setAttribute\('aria-label', `Open note \$\{note\.path\}`\)/);
  assert.match(html, /id="file-edit"[^>]*>Edit file/);
  assert.match(app, /function renderFilePreview\(content, path\)/);
  assert.match(app, /window\.hljs\.highlight\(content, \{ language, ignoreIllegals: true \}\)/);
  assert.match(app, /code\.textContent = content/);
  assert.match(html, /src="\/highlight\.min\.js" defer/);
});

test('host connectivity indicator is removed without removing host health features', () => {
  assert.doesNotMatch(html, /Host Online|Host online|connection-dot|connection-label|topbar-status/);
  assert.doesNotMatch(app, /setConnection|connection-dot|connection-label/);
  assert.doesNotMatch(css, /\.connection-dot|\.topbar-status/);
  assert.match(app, /apiJson\('\/api\/system\/temperature'\)/);
  assert.match(app, /apiJson\('\/api\/devices'\)/);
});

test('calendar month grid stays responsive and exposes accessible touch navigation', () => {
  assert.match(css, /\.calendar-month-grid \{ width:100%; table-layout:fixed;/);
  assert.match(css, /\.calendar-day-button \{ display:flex; width:100%; min-height:52px;/);
  assert.match(css, /\.calendar-nav-button,\.calendar-today-button \{ min-width:44px; min-height:44px;/);
  assert.match(css, /\.calendar-event-actions button \{ min-height:44px; \}/);
  assert.match(css, /@media \(max-width:1170px\)[\s\S]*\.local-calendar-layout \{ grid-template-columns:minmax\(0,1fr\);/);
  assert.match(css, /@media \(max-width:1170px\)[\s\S]*\.calendar-day-button \{ min-height:48px;/);
  assert.match(css, /@media \(max-width:600px\)[\s\S]*\.calendar-month-grid \{ display:none; \}[\s\S]*\.calendar-mobile-picker \{ display:grid;[\s\S]*\.calendar-mobile-agenda \{ display:grid;/);
  assert.match(css, /\.calendar-mobile-picker input \{ width:100%; min-width:0; min-height:48px;/);
  assert.match(localCalendar, /mobileDateInput\.addEventListener\('change'/);
  assert.match(localCalendar, /function renderMobileAgenda\(\)/);
  assert.match(localCalendar, /countEventsByDay\(events, timeZone\)/);
  assert.match(localCalendar, /dayKeyInTimeZone\(new Date\(event\.start\), timeZone\)/);
  assert.match(localCalendar, /formatEventTime\(event, timeZone\)/);
  assert.doesNotMatch(css, /\.calendar-month-grid[^}]*min-width:\s*\d{3,}/);
});

test('System settings separates confirmed Pi extension and CLI updates', () => {
  for (const id of ['update-pi-extensions', 'pi-extensions-update-status', 'update-pi-runtime', 'pi-runtime-update-status']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /role="status" aria-live="polite"><\/p>[\s\S]*id="extensions-list"/);
  assert.match(html, /Project-local packages are skipped/);
  assert.match(html, /Friday’s bundled Pi SDK is managed by Friday deployments/);
  assert.match(app, /window\.confirm\(extensionUpdate[\s\S]*Update the Pi CLI on this host/);
  assert.match(app, /JSON\.stringify\(\{ confirmed: true \}\)/);
  assert.match(app, /apiJson\('\/api\/pi\/update-status'/);
});

test('dashboard renders the initial temperature after attaching its DOM', () => {
  const dashboard = app.indexOf('async function loadDashboard()');
  const attach = app.indexOf('cards.replaceChildren(page);', dashboard);
  const initialRender = app.indexOf('renderDashboardTemperature(temperature);', dashboard);
  assert.ok(attach >= 0 && initialRender > attach, 'initial temperature render must occur after dashboard DOM attachment');
});

test('dashboard presents host temperature with safe unavailable states and infrequent polling', () => {
  assert.match(app, /apiJson\('\/api\/system\/temperature'\)/);
  assert.match(app, /Unsupported on this host/);
  assert.match(app, /Sensor access restricted/);
  assert.match(app, /dashboard-temperature/);
  assert.match(app, /setTimeout\(async \(\) => \{[\s\S]*?\}, 60_000\)/);
  assert.match(app, /clearTimeout\(dashboardTemperatureTimer\)/);
});

test('dashboard refreshes agent busy state while visible', () => {
  assert.match(app, /apiJson\('\/api\/friday\/status'\), apiJson\('\/api\/status'\)/);
  assert.match(app, /dashboardStatusRefreshInterval = 3_000/);
  assert.match(app, /data-dashboard-agent-status/);
  assert.match(app, /data-dashboard-active-agents/);
  assert.match(app, /request !== dashboardStatusRequest \|\| state\.activeFeature !== 'dashboard'/);
  assert.match(app, /scheduleDashboardStatusRefresh\(\);/);
});

test('assistant rail and launch buttons hide in either full chat view', () => {
  assert.match(app, /\['friday', 'pi'\]\.includes\(getFeature\(\)\)/);
  assert.match(app, /assistant\.hidden = chatFeature/);
  assert.match(app, /button\.hidden = chatFeature/);
  assert.match(app, /assistantExpanded = !assistantExpanded/);
  assert.match(css, /\.shell\[data-assistant="closed"\]/);
});

test('financial summary values start censored and toggle independently', () => {
  for (const id of ['finance-balance', 'finance-income', 'finance-expenses']) {
    assert.match(html, new RegExp(`data-finance-target="${id}"`));
  }
  assert.equal((html.match(/class="financial-sensitive is-censored" aria-hidden="true"/g) || []).length, 3);
  assert.match(app, /const visibleFinanceValues = new WeakSet\(\)/);
  assert.match(app, /function updateFinanceVisibility\(targets, button, label\)/);
  assert.match(app, /createFinanceVisibilityButton\(dashboardFinanceValues, 'financial snapshot'\)/);
  assert.match(app, /createFinanceVisibilityButton\(value, 'monthly expenses', true\)/);
  assert.doesNotMatch(app, /createFinanceVisibilityButton\(income,/);
  assert.match(app, /'••••••'/);
  assert.doesNotMatch(app, /financeSummaryVisible/);
  assert.doesNotMatch(app, /markFinancialSensitive\(chart\)/);
  assert.doesNotMatch(css, /financial-sensitive[^}]*filter:\s*blur/);
});

test('dashboard welcome and workspace branding use the simplified Studio UI', () => {
  assert.match(html, /<strong>FRIDAY<\/strong><small>Studio<\/small>/);
  assert.match(app, /Good morning.*Good afternoon.*Good evening/s);
  assert.match(app, /\$\{greeting\}, Cornelius\./);
  assert.match(app, /className = 'dashboard-clock'/);
  assert.match(app, /find\(\(device\) => device\.self\)\?\.hostname/);
  assert.match(app, /Number\(friday\.running === true\) \+ Number\(pi\.piRunning === true\)/);
  assert.match(app, /dashboard-clock-seconds/);
  assert.match(app, /loadFridayDirectory\(\)/);
  assert.match(html, /id="friday-workspace-directory"[^>]*disabled readonly/);
  assert.match(css, /\.feature\[data-feature="friday"\]\.active/);
  assert.match(app, /\['Ask Friday', 'friday'\], \['Pi workspace', 'pi'\]/);
  assert.doesNotMatch(app, /Open workspace|YOUR WORLD, CONNECTED|A clear mind\.|FRIDAY NEURAL CORE/);
  assert.match(css, /\.dashboard-orbit[^}]*width:clamp\(/);
  assert.match(html, /class="brand-mark"[^>]*>Fr<\/span>/);
  assert.doesNotMatch(html, /<strong>FRIDAY<\/strong><small>Personal operating system<\/small>/);
  assert.match(login, /class="logo"[^>]*>Fr<\/span>/);
  assert.match(login, /Workspace locked/);
  assert.match(login, /#72d9e5/);
  assert.match(login, /src="\/login.js"/);
  assert.doesNotMatch(login, /href="\/styles.css"/); // Workspace styles require authentication.
  for (const id of ['login-form', 'password', 'error', 'login-toast']) assert.ok(login.includes(`id="${id}"`));
});

test('public app browser regression suite', { skip: process.env.FRIDAY_BROWSER_TEST !== '1', timeout: 120_000 }, async () => {
  await runBrowserCheck(root);
});
