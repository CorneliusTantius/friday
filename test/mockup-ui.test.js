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
const fridayCalendarTools = await readFile(new URL('../src/friday/friday-calendar-tools.js', import.meta.url), 'utf8');
const fridayPrompt = await readFile(new URL('../src/friday/friday-system-prompt.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const prototype = await readFile(new URL('../mockup.html', import.meta.url), 'utf8');
const login = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');

test('Pi staff names are session titles and generated names require explicit acceptance', () => {
  assert.match(html, /id="pi-session-name-suggestion"[^>]*hidden/);
  assert.match(html, /id="pi-session-current-name"/);
  assert.match(html, /id="pi-regenerate-session-name"[^>]*>Generate another/);
  assert.match(html, /id="pi-accept-session-name"[^>]*>Rename session/);
  assert.match(app, /sessionStorage\.setItem\('friday-new-pi-run-id', data\.runId\)/);
  assert.match(app, /await suggestPiSessionName\(newRunId\)/);
  assert.match(app, /window\.prompt\('Rename session \(suggested name\)', suggestion\)/);
  assert.match(app, /apiJson\('\/api\/session\/rename'/);
  assert.match(app, /JSON\.stringify\(\{ cwd: session\.cwd, path: session\.path, name: piSessionNameValue\.textContent \}\)/);
  assert.match(app, /session\.path !== state\.currentSessionPath \|\| session\.cwd !== elements\.workspace\.value/);
  assert.match(sessionCards, /function generatePiSessionName\(sessions, excludeSessionPath = null\)/);
  assert.doesNotMatch(app, /displayName|staff-name-suggestion/);
});

test('Pi Agent session cards omit recent-message previews and preserve full-chat actions', () => {
  assert.match(html, /id="pi-session-overview"[^>]*aria-labelledby="pi-session-overview-title"/);
  assert.match(html, /id="pi-session-cards"[^>]*aria-label="Saved sessions"/);
  assert.match(html, /class="workspace-field pi-workspace-field"/);
  assert.match(html, /id="pi-chat-view" hidden/);
  assert.match(html, /id="pi-back-to-sessions"[^>]*hidden>All sessions/);
  assert.match(app, /className = `pi-session-card\$\{item\.path === currentPath \? ' selected' : ''\}`/);
  assert.match(app, /className = `session-state \$\{sessionStatus\.className\}`/);
  assert.match(app, /Open conversation/);
  assert.match(app, /card\.append\(heading, meta, actions\)/);
  assert.doesNotMatch(app, /sessionPreview|pi-session-preview|pi-preview-message|\/api\/session\/preview/);
  assert.match(app, /function openSession\(sessionPath\)[\s\S]*await Promise\.all\(\[loadHistory/);
  assert.match(app, /rename\.addEventListener\('click', \(\) => void manageSession\('rename', item\)\)/);
  assert.match(app, /remove\.addEventListener\('click', \(\) => void manageSession\('delete', item\)\)/);
  assert.match(app, /function showPiOverview\(\)/);
  assert.match(app, /function showPiChat\(\)/);
  assert.match(css, /\.pi-session-cards \{ display:grid; grid-template-columns:repeat\(auto-fill/);
  assert.match(css, /\.pi-session-card-heading \{ display:flex; min-width:0; align-items:center;/);
  assert.match(css, /\.pi-session-card-heading h3 \{ min-width:0; margin:0; overflow-wrap:anywhere;[^}]*white-space:normal/);
  assert.match(css, /\.pi-session-card-heading \.session-state \{ flex:none; white-space:nowrap; \}/);
  assert.doesNotMatch(css, /pi-session-preview|pi-preview-message|pi-preview-content|pi-preview-retry/);
  assert.match(css, /\.pi-session-card \{ display:flex; min-width:0; flex-direction:column;/);
  assert.match(app, /heading\.append\(title, statusLabel\)/);
  assert.doesNotMatch(server, /sessionPreview|readSessionPreview|\/api\/session\/preview/);
});

test('Pi overview removes its redundant header and keeps creation and active-session controls discoverable', () => {
  const piStart = html.indexOf('<section id="pi-feature"');
  const piFeature = html.slice(piStart, html.indexOf('</section>', piStart));
  const overviewStart = html.indexOf('<section id="pi-session-overview"', piStart);
  const overviewEnd = html.indexOf('</section>', overviewStart);
  const overview = html.slice(overviewStart, overviewEnd);
  const chatStart = html.indexOf('<div id="pi-chat-view"', piStart);
  const chatView = html.slice(chatStart, html.indexOf('<section id="files-feature"', chatStart));
  assert.doesNotMatch(piFeature, /<header class="header">|<h1>Pi agent<\/h1>|<span class="eyebrow">Pi Agent<\/span>/);
  assert.match(overview, /<h2 id="pi-session-overview-title"[^>]*>Your sessions<\/h2>/);
  assert.match(overview, /<div class="pi-overview-actions">[\s\S]*?<button id="reset"[^>]*aria-label="New Pi session"[\s\S]*?New session[\s\S]*?<button id="refresh-sessions"/);
  assert.equal((html.match(/id="reset"/g) || []).length, 1, 'the existing New session flow has one button');
  assert.match(chatView, /<header class="pi-active-session-header">\s*<button id="pi-back-to-sessions"[^>]*hidden>All sessions<\/button>\s*<h2 id="pi-active-session-title">Current session<\/h2>/);
  assert.match(chatView, /<span id="status" class="status" role="status" aria-live="polite">Starting…<\/span>/);
  assert.doesNotMatch(chatView, /id="reset"/);
  assert.match(app, /const currentSession = items\.find\(\(item\) => item\.path === currentPath\);\s*elements\.piActiveSessionTitle\.textContent = currentSession\?\.name \|\| currentSession\?\.title/);
  assert.match(app, /piActiveSessionTitle\.textContent = currentPiSessions\.find\(\(item\) => item\.path === sessionPath\)\?\.name \|\| 'Opening session…'/);
  assert.match(app, /elements\.reset\.addEventListener\('click'/);
  assert.match(css, /\.pi-overview-actions \{ display:flex; flex:0 0 auto; align-items:center;/);
  assert.match(css, /\.pi-active-session-header h2 \{ min-width:0; flex:1;[^}]*overflow-wrap:anywhere/);
  assert.match(css, /#pi-chat-view\[hidden\] \{ display:none; \}/);
  assert.match(css, /#pi-back-to-sessions \{ flex:0 0 auto; white-space:nowrap; \}/);
  assert.match(css, /@media \(max-width:600px\)[\s\S]*\.pi-overview-actions \{ flex:1 1 100%; \}/);
});

test('global command search is removed while navigation and assistant shortcuts remain', () => {
  assert.doesNotMatch(html, /app-topbar|workspace-topbar|topbar-page/);
  assert.doesNotMatch(css, /\.app-topbar|#topbar-page|topbar-breadcrumb/);
  assert.doesNotMatch(html, /id="shell-command-(?:dialog|input|trigger)"|id="command-close"/);
  assert.doesNotMatch(app, /shell-command|commandInput|commandResults|openCommands|renderCommands|commandFeature|event\.key\.toLowerCase\(\) === 'k'/);
  assert.match(app, /event\.key\.toLowerCase\(\) === 'j'/, 'the assistant shortcut remains');
  assert.match(app, /for \(const button of featureButtons\) button\.addEventListener\('click', \(\) => void setFeature/);
  assert.match(html, /<nav class="shell-mobile-shortcuts" aria-label="Mobile shortcuts">/);
  assert.doesNotMatch(css, /shell-search-trigger|shell-command-dialog|shell-command-input|command-results|command-footer|#command-empty|\bkbd\b/);
  assert.doesNotMatch(prototype, /search-trigger|command-dialog|command-input|command-results|commandDialog|openCommand|command palette|Ctrl K|===\s*'k'/i, 'the standalone Friday prototype also has no dead command search');
  assert.match(prototype, /Ctrl J/);
});

test('global app header is removed and Friday assistant access remains in the sidebar', () => {
  const sidebarStart = html.indexOf('<aside id="workspace-sidebar" class="sidebar workspace-sidebar"');
  const sidebarEnd = html.indexOf('<main id="main-content"', sidebarStart);
  const sidebar = html.slice(sidebarStart, sidebarEnd);
  assert.doesNotMatch(html, /app-topbar|workspace-topbar|topbar-page/);
  assert.match(sidebar, /<div class="sidebar-footer">\s*<button class="feature shell-assistant-toggle" type="button" data-shell-drawer="assistant" aria-label="Open Friday assistant" aria-controls="assistant-rail" aria-expanded="false">[\s\S]*?<span>Friday assistant<\/span><\/button>/);
  assert.match(html, /<nav class="shell-mobile-shortcuts" aria-label="Mobile shortcuts">[\s\S]*?data-shell-drawer="sidebar"[^>]*>[^<]*<svg[\s\S]*?More<\/button>/);
  assert.doesNotMatch(app, /updateTopbar|topbar-page|workspace-topbar/);
  assert.doesNotMatch(css, /\.app-topbar|#topbar-page|workspace-topbar|topbar-breadcrumb/);
  assert.match(css, /\.shell \{ grid-template-columns:235\.4px minmax\(0,1fr\) 320px; grid-template-rows:minmax\(0,1fr\); \}/);
  assert.match(css, /\.feature-shell \{ grid-column:2; grid-row:1;/);
  assert.match(css, /\.assistant-rail \{ grid-column:3; grid-row:1;/);
  assert.match(css, /\.sidebar-footer \.shell-assistant-toggle \{ width:100%; justify-content:flex-start/);
});

test('public workspace UI contract has every feature, form, and shell integration', () => {
  for (const id of ['friday-feature','pi-feature','files-feature','dashboard-feature','repos-feature','notes-feature','finances-feature','socials-feature','calendar-feature','settings-feature','friday-form','friday-chat-queue','friday-compaction-status','friday-stop','chat-form','file-save','finance-form','clone-repo-form','workspace-sidebar','assistant-rail']) {
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
  assert.match(css, /\.pi-layout \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(css, /\.pi-layout \{ display: grid; grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /@media \(max-width:1000px\)[\s\S]*\.pi-layout,\.files-layout,\.notes-layout \{ display:block; \}/);
  assert.match(sessionCards, /Edit staff profile/);
  assert.match(sessionCards, /labels = \{ expertise: 'Expertise', responsibilities: 'Responsibilities'/);
  assert.match(sessionCards, /if \(name === 'responsibilities'\) input\.maxLength = 500/);
  assert.match(sessionCards, /One per line · 500 characters total maximum/);
  assert.doesNotMatch(sessionCards, /`Expertise:|`Responsibilities:/);
  assert.match(sessionCards, /state\.profile\.textContent = `Workload: \$\{session\.workload\?\.openTasks/);
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
  assert.match(chat, /const POLL_INTERVAL_MS = 2_000/);
  assert.match(chat, /document\.addEventListener\('visibilitychange'/);
  assert.match(css, /\.friday-task-board \{[^}]*align-content:start/);
  assert.doesNotMatch(chat, /EventSource|events\/token/);
  assert.match(sessionCards, /session\.opening \? 'Opening'/);
  assert.match(sessionCards, /session\.running \? 'Open' : 'Saved'/);
  assert.match(sessionCards, /Working.*queued/);
  assert.match(app, /activeFridaySession = id; await Promise\.all\(\[fridayChat\.enterView\(\), refreshFridaySessions\(\)\]\);/);
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
  const socialsPage = html.match(/<section id="socials-feature"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  const calendarPage = html.slice(html.indexOf('id="calendar-feature"'), html.indexOf('id="settings-feature"'));
  assert.equal(socialsPage?.trim(), '', 'Socials remains a blank feature target');
  assert.doesNotMatch(html, /Slack|slack|socials\.js|connections-settings-group/i);
  assert.doesNotMatch(server, /slack|socials\.js|\/api\/socials\//i);
  assert.doesNotMatch(fridayCalendarTools, /slack/i);
  assert.doesNotMatch(fridayPrompt, /slack/i);
  assert.doesNotMatch(html, /gmail|Gmail/i, 'Gmail is removed from user-facing pages');
  assert.doesNotMatch(server, /gmail|Gmail|FRIDAY_GMAIL/);
  assert.doesNotMatch(fridayCalendarTools, /gmail|Gmail/);
  assert.doesNotMatch(fridayPrompt, /gmail|Gmail/);
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
  assert.ok(server.includes("join(paths.dataDir, 'calendar', 'events.json')"), 'local events are stored under private Friday data');
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

test('mobile navigation uses the bottom More drawer with no top header or hamburger', () => {
  const shortcutsStart = html.indexOf('<nav class="shell-mobile-shortcuts"');
  const shortcutsEnd = html.indexOf('</nav>', shortcutsStart) + '</nav>'.length;
  const shortcuts = html.slice(shortcutsStart, shortcutsEnd);
  assert.doesNotMatch(html, /app-topbar|workspace-topbar|shell-menu-toggle|aria-label="Open navigation"/);
  assert.match(shortcuts, /data-shell-drawer="sidebar" aria-controls="workspace-sidebar" aria-expanded="false"[^>]*>[\s\S]*?More<\/button>/);
  for (const destination of ['Pi', 'Friday', 'Dashboard', 'Finance', 'More']) assert.match(shortcuts, new RegExp(`${destination}<\\/button>`));
  assert.match(app, /for \(const button of document\.querySelectorAll\('\[data-shell-drawer\]'\)\)/);
  assert.match(css, /\.sidebar\.shell-drawer-open \{ transform:none; visibility:visible; \}/);
  assert.match(css, /\.shell\[data-feature="friday"\].*grid-template-columns:235\.4px minmax\(0,1fr\)/);
  assert.match(css, /@media \(max-width:600px\)[\s\S]*\.shell-mobile-shortcuts \{ display:flex; position:fixed;/);
});

test('main feature content uses shared responsive padding and wider navigation sidebar', () => {
  assert.match(css, /--main-content-inset-block: 32px;[\s\S]*--main-content-inset-inline: 32px;/);
  assert.match(css, /#main-content \{ padding:var\(--main-content-inset-block\) var\(--main-content-inset-inline\); \}/);
  assert.match(css, /@media \(min-width:1700px\)[\s\S]*--main-content-inset-block:40px; --main-content-inset-inline:40px;/);
  assert.match(css, /@media \(max-width:1390px\)[\s\S]*--main-content-inset-block:28px; --main-content-inset-inline:24px;/);
  assert.match(css, /@media \(max-width:600px\)[\s\S]*--main-content-inset-block:0px; --main-content-inset-inline:0px;/);
  assert.match(css, /\.feature-page \{ padding:0; \}/);
  assert.match(css, /\.app \{[^}]*padding: 0; \}/);
  assert.match(css, /\.feature-page \{ padding:23px 16px 18px; \}/);
  assert.match(css, /\.feature-page \{ padding:19px 12px 14px; \}/);
  assert.match(css, /\.app \{ padding-block-end:max\(.8rem,env\(safe-area-inset-bottom\)\); \}/);
  assert.match(css, /@media \(min-width:1700px\)[\s\S]*\.shell \{ grid-template-columns:235\.4px minmax\(0,1fr\) 355px;/);
  assert.match(css, /\.shell \{ grid-template-columns:235\.4px minmax\(0,1fr\) 320px;/);
  assert.match(css, /\.shell \{ grid-template-columns:209px minmax\(0,1fr\) 285px;/);
  assert.match(css, /grid-template-columns:77px minmax\(0,1fr\)/);
  assert.match(css, /\.sidebar \{ position:fixed;[^}]*width:264px;/);
});

test('Friday chat omits the avatar without a reserved column and retains sender identification', () => {
  assert.doesNotMatch(chat, /message-avatar|textContent = 'F'/);
  assert.match(chat, /const labelText = message\.role === 'user' \? 'You' : message\.role === 'event' \? 'Friday · Task update' : 'Friday'/);
  assert.match(chat, /if \(label\.textContent !== labelText\) label\.textContent = labelText/);
  assert.match(css, /\.friday-app \.message \{ grid-template-columns:minmax\(0,1fr\); gap:0; \}/);
  assert.match(css, /\.message-avatar \{ display: grid; width: 1\.75rem/);
});

test('Friday automatic-compaction failures are surfaced accessibly without provider error text', () => {
  assert.match(html, /id="friday-compaction-status" class="compaction-status" role="status" aria-live="polite" hidden/);
  assert.match(chat, /failed: 'Automatic compaction failed; your message is retained\./);
  assert.match(chat, /'unknown-window': 'The 75% compaction threshold is unavailable/);
  assert.match(chat, /configuration: 'The 75% compaction threshold could not be configured/);
  assert.match(chat, /compactionStatus\.textContent = warningText/);
});

test('Friday chat removes its redundant title and places accessible live status above the composer input', () => {
  const headerStart = html.indexOf('<header class="header friday-chat-header">');
  const headerEnd = html.indexOf('</header>', headerStart);
  const header = html.slice(headerStart, headerEnd);
  assert.doesNotMatch(header, /<h1>|id="friday-status"/);
  assert.match(header, /data-shell-drawer="sidebar"[^>]*aria-label="Open Friday conversations"/);
  assert.match(header, /id="friday-pi-sessions-toggle"/);
  assert.match(header, /class="assistant-rail-tools"/);
  const formStart = html.indexOf('<form id="friday-form"');
  const formEnd = html.indexOf('</form>', formStart);
  const form = html.slice(formStart, formEnd);
  const statusRow = html.slice(html.indexOf('<div class="friday-composer-status-row">'), formStart);
  assert.match(statusRow, /<div class="friday-composer-status-row">\s*<span id="friday-status" class="status" role="status" aria-live="polite">Connecting…<\/span>\s*<div id="friday-compaction-status" class="compaction-status" role="status" aria-live="polite" hidden><\/div>\s*<\/div>\s*$/);
  assert.match(form, /<textarea id="friday-message"/);
  assert.doesNotMatch(form, /friday-status|friday-compaction-status/);
  assert.equal((html.match(/id="friday-status"/g) || []).length, 1);
  assert.equal((html.match(/id="friday-compaction-status"/g) || []).length, 1);
  assert.match(css, /\.friday-composer-status-row \{ display:flex;[^}]*flex-wrap:wrap/);
  assert.match(css, /#friday-status\[data-state="ready"\][^{]*\{[^}]*color:var\(--accent\)/);
  assert.match(css, /#friday-status\[data-state="error"\][^{]*\{[^}]*color:var\(--red\)/);
  assert.match(css, /\.compaction-status \{ max-width:100%; flex:1 1 100%;/);
  assert.doesNotMatch(css, /#friday-status \{[^}]*position:absolute/);
  assert.match(css, /\.shell\[data-feature="friday"\] \.friday-app > \.friday-chat-header \{ display:none; \}/);
  assert.match(css, /@media \(max-width:1170px\)[\s\S]*\.shell\[data-feature="friday"\] \.friday-app > \.friday-chat-header \{ display:flex;/);
});

test('Friday composer hints newline on mobile and retains desktop Enter/IME policy', () => {
  assert.match(html, /<textarea id="friday-message"[^>]*enterkeyhint="enter"[^>]*>/);
  assert.match(html, /<button id="friday-send" class="send-button" type="submit"/);
  assert.match(chat, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(chat, /window\.matchMedia\?\.\('\(max-width: 600px\)'\)\.matches/);
});

test('Friday chat follows latest updates after layout while retaining explicit scroll intent', () => {
  assert.match(html, /<section id="friday-messages" class="messages" aria-label="Friday conversation">/);
  assert.match(chat, /const stick = scrollToLatestOnVisibleRender \|\| followsLatest \|\| nearBottom\(\)/);
  assert.match(chat, /requestAnimationFrame\(\(\) =>/);
  assert.match(chat, /window\.ResizeObserver/);
  assert.match(chat, /messages\.addEventListener\('scroll', \(\) => \{ followsLatest = nearBottom\(\); \}/);
  assert.match(css, /\.friday-app \.messages \{ scroll-behavior:auto; \}/);
});

test('Friday conversations submenu opens only from its explicit keyboard-accessible toggle', () => {
  const navStart = html.indexOf('id="friday-nav-entry"');
  const navEnd = html.indexOf('</div>', html.indexOf('id="friday-sidebar"', navStart));
  const submenu = html.slice(navStart, html.indexOf('</aside>', navStart) + '</aside>'.length);
  const fridayFeature = html.slice(html.indexOf('id="friday-feature"'), html.indexOf('id="pi-feature"'));
  assert.ok(navStart >= 0 && navEnd > navStart);
  assert.equal((html.match(/id="friday-sidebar"/g) || []).length, 1);
  assert.equal((html.match(/id="friday-session-list"/g) || []).length, 1);
  assert.match(submenu, /data-feature="friday"[^>]*aria-controls="friday-sidebar"/);
  assert.match(submenu, /id="friday-submenu-toggle"[^>]*aria-controls="friday-sidebar"[^>]*aria-expanded="false"/);
  assert.match(submenu, /id="friday-session-list"/);
  assert.doesNotMatch(fridayFeature, /friday-sidebar|friday-session-list/);
  for (const id of ['friday-new-conversation', 'friday-review-memory', 'friday-refresh-sessions', 'friday-session-list']) assert.match(submenu, new RegExp(`id="${id}"`));
  assert.match(css, /\.friday-layout \{ grid-template-columns:minmax\(0,1fr\) minmax\(320px,35%\); \}/);
  assert.match(css, /@media \(max-width:1390px\)[\s\S]*\.friday-layout \{ grid-template-columns:minmax\(0,1fr\) minmax\(320px,35%\); \}/);
  assert.match(css, /\.friday-nav-entry\.submenu-open > \.friday-nav-menu \{ display: flex;/);
  assert.match(css, /#friday-sidebar \{ height: min\(42dvh,360px\); min-height: 210px; max-height: 42dvh; \}/);
  assert.doesNotMatch(css, /\.friday-nav-entry\.submenu-open > \.friday-nav-menu \{ position: absolute/);
  const tablet = css.slice(css.indexOf('@media (max-width:1170px)'), css.indexOf('@media (max-width:1000px)'));
  assert.match(tablet, /\.friday-layout \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(tablet, /\.friday-pi-sidebar \{ position:fixed;[\s\S]*width:min\(84vw,310px\)/);
  const narrow = css.slice(css.indexOf('@media (max-width:800px)'), css.indexOf('@media (max-width:600px)'));
  assert.match(narrow, /\.friday-app \.header-title \.drawer-toggle \{ display:grid; \}/);
  assert.doesNotMatch(narrow, /#friday-sidebar \{ position:absolute/);
  const mobile = css.slice(css.indexOf('@media (max-width:600px)'));
  assert.doesNotMatch(mobile, /#friday-sidebar[^}]*position:absolute/);
  assert.match(html, /id="friday-submenu-toggle" class="friday-submenu-toggle" type="button" aria-label="Show Friday conversations" aria-controls="friday-sidebar" aria-expanded="false"/);
  assert.match(app, /let fridaySubmenuExpanded = false/);
  assert.match(app, /classList\.toggle\('submenu-open', fridaySubmenuExpanded\)/);
  assert.match(app, /fridaySubmenuExpanded = !fridaySubmenuExpanded/);
  assert.match(app, /aria-expanded', String\(fridaySubmenuExpanded\)/);
  assert.doesNotMatch(app, /fridayMenuHovered|fridayMenuOverride/);
  assert.doesNotMatch(app, /fridayNavEntry\.addEventListener\('(pointerenter|pointerleave|focusin|focusout)'/);
  for (const action of ['Rename', 'Delete']) assert.match(app, new RegExp(`textContent = '${action}'`));
  assert.match(app, /confirm\(`Delete/);
  assert.match(app, /open\.setAttribute\('aria-current', id === activeFridaySession \? 'true' : 'false'\)/);
  assert.match(html, /id="friday-pi-sidebar"/);
});

test('Friday session details start collapsed and preserve only explicit expansion across refreshes', () => {
  assert.match(app, /const fridaySessionDetailsOpen = new Set\(\)/);
  assert.match(app, /const details = document\.createElement\('details'\); details\.className = 'friday-session-disclosure'/);
  assert.match(app, /details\.open = fridaySessionDetailsOpen\.has\(id\)/);
  assert.match(app, /details\.addEventListener\('toggle', \(\) => \{\s*if \(details\.open\) fridaySessionDetailsOpen\.add\(id\); else fridaySessionDetailsOpen\.delete\(id\);/);
  assert.match(app, /item\.append\(open, details\)/);
  assert.match(css, /\.friday-session-disclosure > summary \{[^}]*cursor:pointer/);
  assert.match(css, /\.friday-session-disclosure > \.session-meta \{[^}]*display:block/);
});

test('Friday workspace path is selectable code and new-conversation controls stay compact and accessible', () => {
  const fridayNewStart = html.indexOf('<button id="friday-new-conversation"');
  const fridayNewButton = html.slice(fridayNewStart, html.indexOf('</button>', fridayNewStart) + '</button>'.length);
  const piNewStart = html.indexOf('<button id="reset"');
  const piNewButton = html.slice(piNewStart, html.indexOf('</button>', piNewStart) + '</button>'.length);
  assert.match(css, /\.friday-workspace-path \{[^}]*font:10px\/1\.4 var\(--mono\); user-select:text/);
  assert.match(css, /\.friday-workspace-path \{[^}]*overflow-wrap:anywhere/);
  assert.match(app, /state\.fridayWorkspace = data\.fridayChat\?\.directory \|\| ''/);
  assert.match(app, /elements\.fridayWorkspaceDirectory\.textContent = directory/);
  assert.doesNotMatch(app, /fridayWorkspaceDirectory\.value/);
  assert.match(fridayNewButton, /class="icon-button"[^>]*aria-label="New Friday conversation" title="New conversation"/);
  assert.doesNotMatch(fridayNewButton, /New Conversation/);
  assert.match(app, /apiJson\('\/api\/friday\/sessions', \{ method: 'POST' \}/);
  assert.match(piNewButton, /aria-label="New Pi session" title="New Pi session"/);
  assert.match(piNewButton, /<span>New session<\/span>/);
  assert.match(app, /apiJson\('\/api\/session\/reset'/);
});

test('staff cards combine selectable repository visibility and profile editing in one dropdown', () => {
  assert.match(app, /createFridayPiSessionCards/);
  assert.match(app, /onSaveVisibility: async \(session, hiddenRepositories\)/);
  assert.match(sessionCards, /Visible repositories/);
  assert.match(sessionCards, /session\.availableRepositories/);
  assert.match(sessionCards, /session\.visibleRepositories/);
  assert.match(sessionCards, /Staff profile and repositories/);
  assert.match(sessionCards, /Edit staff profile/);
  assert.match(sessionCards, /friday-repo-visibility-form/);
  assert.match(sessionCards, /Save visibility/);
  assert.match(sessionCards, /not a filesystem sandbox/);
  assert.doesNotMatch(sessionCards, /Repo affinity|repositories: textLines/);
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
  assert.match(css, /\.friday-task-preview \{[^}]*text-overflow:ellipsis; white-space:nowrap/);
  assert.match(css, /\.friday-task-panel\[hidden\] \{ display:none; \}/);
  assert.match(css, /@media \(max-width:1170px\)[\s\S]*\.friday-pi-sidebar \.mobile-close/);
});

test('task descriptions do not duplicate expanded previews and sidebar cards stay compact and responsive', () => {
  assert.match(chat, /friday-task-preview/);
  assert.match(chat, /friday-task-review-status/);
  assert.match(chat, /Full description below/);
  assert.match(css, /\.friday-task-details\[open\] \.friday-task-preview \{ display:none; \}/);
  assert.match(css, /\.friday-task-details\[open\] \.friday-task-open-label \{ display:inline; \}/);
  assert.match(css, /\.friday-task-row \{[^}]*border:1px solid var\(--border\)[^}]*background:/);
  assert.match(css, /\.session-item\.friday-session-item \{[^}]*border-color:var\(--border\)[^}]*background:/);
  assert.match(css, /\.friday-session-item \.friday-session-open \{[^}]*display:grid; grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /\.friday-session-item \.session-title \{[^}]*overflow-wrap:anywhere; white-space:normal/);
  assert.match(css, /\.friday-session-item \.friday-session-status-row \{ display:flex;[^}]*justify-content:space-between/);
  assert.match(css, /\.friday-session-item \.friday-staff-workload \{[^}]*font-size:11px; white-space:nowrap/);
  assert.match(css, /\.friday-session-item \.friday-staff-editor \{/);
  assert.match(css, /@media \(max-width:1170px\)[\s\S]*\.friday-pi-sidebar\.open/);
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
  assert.match(html, /<code id="friday-workspace-directory" class="friday-workspace-path" role="status" aria-label="Friday workspace directory">/);
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
