import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const calendarTools = await readFile(new URL('../src/friday/friday-calendar-tools.js', import.meta.url), 'utf8');
const prompt = await readFile(new URL('../src/friday/friday-system-prompt.js', import.meta.url), 'utf8');

test('Socials remains navigable and intentionally blank without connector UI or requests', () => {
  const feature = html.match(/<section id="socials-feature"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(feature, 'Socials keeps its route target');
  assert.equal(feature[1].trim(), '', 'Socials has no placeholder, card, or explanatory content');
  assert.match(html, /data-feature="socials"/);
  assert.match(app, /\['socials', \$\('#socials-feature'\)\]/);
  assert.doesNotMatch(html, /Slack|slack|socials\.js|connections-settings-group/i);
  assert.doesNotMatch(app, /\/api\/socials\//);
  assert.doesNotMatch(server, /slack|socials\.js|\/api\/socials\//i);
  assert.doesNotMatch(styles, /slack-channel-option|socials-provider-mark|socials-list/);
  assert.doesNotMatch(calendarTools, /slack/i);
  assert.doesNotMatch(prompt, /slack/i);
});
