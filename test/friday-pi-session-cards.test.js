import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayPiSessionCards, fetchAndRenderCurrent, generatePiSessionName } from '../public/friday-pi-session-cards.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.parentElement = null;
    this.className = '';
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, reference) {
    if (node === reference) return node;
    node.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentElement = this;
    return node;
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  async dispatch(type) {
    let result;
    for (const listener of this.listeners.get(type) || []) {
      result = listener({ preventDefault() {} });
    }
    return result;
  }
  focus() { this.ownerDocument.activeElement = this; }
}

class FakeDocument {
  activeElement = null;
  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function session(runId, overrides = {}) {
  return {
    id: runId, runId, path: `/${runId}.jsonl`, cwd: '/work', name: runId, modified: 'today', messageCount: 1,
    expertise: ['Node'], responsibilities: ['API'], repositories: ['repo-a', 'repo-b'], capacity: 2,
    availableRepositories: ['repo-a', 'repo-b'], visibleRepositories: ['repo-a', 'repo-b'],
    workload: { openTasks: 0 }, tasks: [],
    ...overrides,
  };
}

test('generated session-name suggestions collide against actual titles, ignoring case, and add safe suffixes', () => {
  assert.equal(generatePiSessionName([]), 'Nova');
  assert.equal(generatePiSessionName([
    session('one', { name: 'nOvA' }), session('two', { name: 'ATLAS' }),
  ]), 'Echo');
  assert.equal(generatePiSessionName([
    ...['nova', 'ATLAS', 'Echo', 'IRIS', 'NOVA 2', 'Nova 3'].map((name, index) => session(`run-${index}`, { name })),
  ]), 'Nova 4');
  const current = session('current', { name: 'Nova' });
  assert.equal(generatePiSessionName([current], current.path), 'Nova', 'suggesting for the current session ignores only its own title');
  assert.equal(current.name, 'Nova', 'suggestions never rename a session');
});

test('staff cards display the real session title and omit legacy alias/repo-affinity profile fields', () => {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement('div');
  const cards = createFridayPiSessionCards({
    container, documentRef, formatDate: (value) => value, onOpen() {}, async onSaveVisibility() {},
    async onSaveProfile() {}, async onRefresh() {}, toast() {},
  });
  cards.render([session('run-a', { name: 'Build task', displayName: 'Old alias', repositories: ['legacy-repo'] })]);
  const card = container.children[0];
  assert.equal(find(card, (node) => node.className === 'session-title').textContent, 'Build task');
  assert.doesNotMatch(card.textContent, /Old alias|legacy-repo|Repo affinity/);
  assert.equal(find(card, (node) => node.name === 'displayName'), null);
  assert.equal(find(card, (node) => node.name === 'repositories'), null);
  assert.ok(find(card, (node) => node.name === 'expertise'));
  assert.ok(find(card, (node) => node.name === 'responsibilities'));
  assert.match(card.textContent, /Workload: 0\/2/);
  assert.match(card.textContent, /not a filesystem sandbox/);
});

test('session cards retain expansion, focus and unsaved controls across polls and keyed updates', async () => {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement('div');
  let sessions = [session('run-a'), session('run-b')];
  const visibilitySaves = [];
  let cards;
  cards = createFridayPiSessionCards({
    container, documentRef, formatDate: (value) => value,
    onOpen() {},
    async onSaveVisibility(current, hidden) {
      visibilitySaves.push({ runId: current.runId, hidden });
      sessions = sessions.map((item) => item.runId === current.runId
        ? { ...item, visibleRepositories: item.availableRepositories.filter((repo) => !hidden.includes(repo)) }
        : item);
    },
    async onSaveProfile() {},
    async onRefresh() { cards.render(sessions); },
    toast() {},
  });

  cards.render(sessions);
  const firstCard = container.children[0];
  const visibility = find(firstCard, (node) => node.tagName === 'details' && node.className.includes('friday-repo-visibility'));
  const editor = find(firstCard, (node) => node.tagName === 'details' && node.className === 'friday-staff-editor');
  visibility.open = true; editor.open = true;
  const repoB = find(firstCard, (node) => node.tagName === 'input' && node.value === 'repo-b');
  repoB.checked = false; await repoB.dispatch('change');
  const expertise = find(firstCard, (node) => node.tagName === 'textarea' && node.name === 'expertise');
  expertise.value = 'Unsaved expertise'; await expertise.dispatch('input'); expertise.focus();

  cards.render(sessions);
  assert.equal(container.children[0], firstCard, 'unchanged polls reuse the exact session card');
  assert.equal(visibility.open, true);
  assert.equal(editor.open, true);
  assert.equal(repoB.checked, false, 'unsaved visibility choice survives an unchanged poll');
  assert.equal(expertise.value, 'Unsaved expertise');
  assert.equal(documentRef.activeElement, expertise);

  sessions = [session('run-a', {
    workload: { openTasks: 1 },
    tasks: [{ id: 'task-1', label: 'Export', status: 'reviewing' }],
  }), sessions[1]];
  cards.render(sessions);
  assert.equal(container.children[0], firstCard, 'task updates do not replace the keyed card');
  assert.equal(visibility.open, true);
  assert.equal(editor.open, true);
  assert.equal(repoB.checked, false, 'unsaved repository selection survives task/workload updates');
  assert.equal(expertise.value, 'Unsaved expertise', 'unsaved profile input survives task/workload updates');
  assert.equal(documentRef.activeElement, expertise);
  assert.match(firstCard.textContent, /Workload: 1\/2/);
  assert.match(firstCard.textContent, /Export: reviewing/);

  const visibilityForm = find(firstCard, (node) => node.tagName === 'form' && node.className === 'friday-repo-visibility-form');
  await visibilityForm.dispatch('submit');
  assert.deepEqual(visibilitySaves, [{ runId: 'run-a', hidden: ['repo-b'] }]);
  assert.equal(container.children[0], firstCard);
  assert.equal(repoB.checked, false, 'saved preference reload remains unchecked');
  assert.equal(find(container.children[1], (node) => node.tagName === 'input' && node.value === 'repo-b').checked, true, 'saving one run does not change another run');

  repoB.checked = true; await repoB.dispatch('change');
  await visibilityForm.dispatch('submit');
  assert.deepEqual(visibilitySaves[1], { runId: 'run-a', hidden: [] }, 'rechecking persists visibility for the exact run');
  assert.equal(repoB.checked, true);
  assert.equal(find(container.children[1], (node) => node.tagName === 'input' && node.value === 'repo-b').checked, true);
});

test('a poll response started before a save cannot render over the newer state', async () => {
  let revision = 1;
  let release;
  let rendered = false;
  const pending = fetchAndRenderCurrent({
    load: () => new Promise((resolve) => { release = resolve; }),
    currentRevision: () => revision,
    render: () => { rendered = true; },
  });
  revision += 1;
  release({ sessions: [] });
  assert.equal(await pending, false);
  assert.equal(rendered, false);
});
