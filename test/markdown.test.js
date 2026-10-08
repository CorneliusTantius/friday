import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

class FakeText {
  constructor(text) { this.textContent = text; }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = { add: (...names) => names.forEach((name) => this.classes.add(name)) };
    this.style = {};
  }

  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get className() { return [...this.classes].join(' '); }
  get textContent() { return this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.children = [new FakeText(String(value))]; }
  descendants() { return this.children.flatMap((child) => child instanceof FakeElement ? [child, ...child.descendants()] : []); }
}

function render(source, t) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeText(text),
  };
  globalThis.window = { location: { href: 'https://friday.test/' } };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const root = new FakeElement('div');
  renderMarkdown(root, source, () => {});
  return root;
}

test('Markdown supports safe HTML br variants and preserves newline breaks', (t) => {
  const root = render('First<br>second<BR />third\nfourth', t);
  const paragraph = root.children[0];
  assert.deepEqual(paragraph.children.map((child) => child.tagName || child.textContent), [
    'First', 'BR', 'second', 'BR', 'third', 'BR', 'fourth',
  ]);
});

test('Markdown task lists render disabled checked and unchecked checkboxes', (t) => {
  const root = render('- [x] Done\n- [ ] Still to do\n+ [X] Also done', t);
  const list = root.children[0];
  assert.equal(list.tagName, 'UL');
  assert.ok(list.classes.has('contains-task-list'));
  assert.equal(list.children.length, 3);
  const [done, pending, uppercase] = list.children;
  for (const item of list.children) assert.ok(item.classes.has('task-list-item'));
  const checkbox = (item) => item.children.find((child) => child.tagName === 'INPUT');
  assert.equal(checkbox(done).type, 'checkbox');
  assert.equal(checkbox(done).checked, true);
  assert.equal(checkbox(done).disabled, true);
  assert.equal(checkbox(done).getAttribute('aria-label'), 'Completed task');
  assert.equal(checkbox(pending).checked, false);
  assert.equal(checkbox(pending).disabled, true);
  assert.equal(checkbox(pending).getAttribute('aria-label'), 'Incomplete task');
  assert.equal(checkbox(uppercase).checked, true);
  assert.match(done.textContent, /Done/);
  assert.match(pending.textContent, /Still to do/);
});

test('unsafe HTML remains literal text and creates no unsafe elements', (t) => {
  const source = '<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">bad</a>';
  const root = render(source, t);
  assert.equal(root.textContent, source);
  assert.deepEqual(root.descendants().map((element) => element.tagName), ['P']);
  assert.doesNotMatch(root.descendants().map((element) => element.tagName).join(','), /SCRIPT|IMG|A/);
});
