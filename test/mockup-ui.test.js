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

test('workspace branding and lock screen use the updated UI', () => {
  assert.match(html, /class="brand-mark"[^>]*>Fr<\/span>/);
  assert.doesNotMatch(html, /Friday workspace|Local environment|class="workspace"/);
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
