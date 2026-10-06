import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runBrowserCheck } from '../test-support/mockup-browser.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const chat = await readFile(new URL('../public/friday-chat.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const login = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');

test('public workspace UI contract has every feature, form, and shell integration', () => {
  for (const id of ['friday-feature','pi-feature','files-feature','dashboard-feature','repos-feature','notes-feature','finances-feature','settings-feature','friday-form','chat-form','file-save','finance-form','clone-repo-form','workspace-sidebar','assistant-rail','shell-command-dialog','shell-command-input']) {
    assert.equal((html.match(new RegExp(`\\bid=["']${id}["']`, 'g')) || []).length, 1, `expected one #${id}`);
  }
  assert.match(html, /data-shell-drawer="assistant"/);
  assert.match(html, /data-shell-drawer="sidebar"/);
  assert.match(app, /initializeWorkspaceShell/);
  assert.match(app, /createFridayChat/);
  assert.match(chat, /apiJson\('\/api\/friday\/chat'/);
  for (const route of ['/styles.css', '/app.js']) assert.ok(html.includes(`"${route}"`));
  assert.ok(app.includes("import('./friday-chat.js')"));
  assert.match(css, /--bg:\s*#0b0e11;/);
  assert.match(css, /--accent:\s*#72d9e5;/);
  for (const variable of ['display', 'mono', 'purple']) assert.match(css, new RegExp(`--${variable}:`));
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
