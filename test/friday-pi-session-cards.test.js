import test from 'node:test';
import assert from 'node:assert/strict';
import { createFridayPiSessionCards, fetchAndRenderCurrent, generatePiSessionName, PI_STAFF_NAME_POOL } from '../public/friday-pi-session-cards.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.parentElement = null;
    this.className = '';
    this._text = '';
    if (tagName === 'details') this.open = false;
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
  setAttribute(name, value) { this[name] = String(value); }
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
  assert.deepEqual(PI_STAFF_NAME_POOL.slice(0, 4), ['Nova', 'Atlas', 'Echo', 'Iris']);
  assert.ok(PI_STAFF_NAME_POOL.length >= 12, 'the AI-style name bank provides a broad set of staff names');
  assert.equal(new Set(PI_STAFF_NAME_POOL.map((name) => name.toLowerCase())).size, PI_STAFF_NAME_POOL.length, 'bank names are unique ignoring case');
  assert.equal(generatePiSessionName([
    ...[...PI_STAFF_NAME_POOL, 'NOVA 2', 'Nova 3'].map((name, index) => session(`run-${index}`, { name })),
  ]), 'Nova 4', 'exhausting the bank falls back to the first name with a collision-safe suffix');
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
  cards.render([session('run-a', { name: 'Build task', displayName: 'Old alias', repositories: ['legacy-repo'], modified: '3m ago', messageCount: 17, workload: { openTasks: 2 }, capacity: 4 })]);
  const card = container.children[0];
  const open = find(card, (node) => node.className === 'session-open friday-session-open');
  assert.equal(find(card, (node) => node.className === 'session-title').textContent, 'Build task');
  assert.equal(open.children.map((node) => node.className).join(','), 'session-title,session-meta', 'name and timestamp/count share the first row');
  assert.equal(find(open, (node) => node.className === 'session-meta').textContent, '3m ago · 17 msg');
  const statusRow = find(card, (node) => node.className === 'friday-session-status-row');
  assert.equal(card.children.indexOf(statusRow), card.children.indexOf(open) + 1, 'workload/status row sits directly below the name/metadata row');
  assert.equal(statusRow.children.map((node) => node.className.split(' ')[0]).join(','), 'friday-staff-workload,session-state');
  assert.equal(find(statusRow, (node) => node.className === 'friday-staff-workload').textContent, 'Workload: 2/4');
  assert.equal(find(statusRow, (node) => node.className.startsWith('session-state')).textContent, 'Saved', 'existing status text is preserved');
  assert.doesNotMatch(card.textContent, /Old alias|legacy-repo|Repo affinity/);
  assert.equal(find(card, (node) => node.name === 'displayName'), null);
  assert.equal(find(card, (node) => node.name === 'repositories'), null);
  const editor = find(card, (node) => node.tagName === 'details' && node.className === 'friday-staff-editor');
  assert.ok(find(editor, (node) => node.name === 'expertise'));
  const responsibilities = find(editor, (node) => node.name === 'responsibilities');
  assert.ok(responsibilities);
  assert.equal(responsibilities.maxLength, 500);
  assert.match(editor.textContent, /Profile details.*Expertise.*Responsibilities.*500 characters total maximum/s);
  assert.doesNotMatch(card.children.filter((child) => child !== editor).map((child) => child.textContent).join(' '), /Expertise:|Responsibilities:/);
  assert.match(card.textContent, /Workload: 2\/4/);
  assert.match(card.textContent, /not a filesystem sandbox/);
});

test('session cards omit navigation label controls and display the session title', () => {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement('div');
  const cards = createFridayPiSessionCards({
    container, documentRef, formatDate: (value) => value, onOpen() {}, async onSaveVisibility() {}, async onSaveProfile() {},
    async onRefresh() {}, toast() {},
  });
  cards.render([session('run-a', { name: 'Actual staff name', navigationLabel: 'Old navigation label' })]);
  const card = container.children[0];
  assert.equal(find(card, (node) => node.className === 'session-title').textContent, 'Actual staff name');
  assert.equal(find(card, (node) => node.name === 'navigationLabel'), null);
  assert.equal(find(card, (node) => node.className === 'friday-navigation-label-form'), null);
  assert.doesNotMatch(card.textContent, /Edit navigation label|Save label|Clear label/);
});

test('profile dropdown submits edited expertise, responsibilities, and capacity', async () => {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement('div');
  let saved;
  const cards = createFridayPiSessionCards({
    container, documentRef, formatDate: (value) => value, onOpen() {}, async onSaveVisibility() {},
    async onSaveProfile(current, profile) { saved = { runId: current.runId, ...profile }; },
    async onRefresh() {}, toast() {},
  });
  cards.render([session('run-a')]);
  const card = container.children[0];
  const editor = find(card, (node) => node.tagName === 'details' && node.className === 'friday-staff-editor');
  editor.open = true;
  find(editor, (node) => node.name === 'expertise').value = 'Node.js\nAccessibility';
  find(editor, (node) => node.name === 'responsibilities').value = 'Build tools\nReview changes';
  find(editor, (node) => node.name === 'capacity').value = '3';
  await find(editor, (node) => node.tagName === 'form' && node.className === 'friday-staff-profile-form').dispatch('submit');
  assert.deepEqual(saved, {
    runId: 'run-a', expertise: ['Node.js', 'Accessibility'], responsibilities: ['Build tools', 'Review changes'], capacity: 3,
  });
});

test('session cards combine editable repositories and profile in one persistent dropdown', async () => {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement('div');
  let sessions = [session('run-a'), session('run-b', {
    tasks: [{ id: 'task-2', label: 'Initial task', status: 'queued' }],
  })];
  let savedProfile;
  const visibilitySaves = [];
  let cards;
  cards = createFridayPiSessionCards({
    container, documentRef, formatDate: (value) => value,
    onOpen() {},
    async onSaveVisibility(current, hiddenRepositories) {
      visibilitySaves.push({ runId: current.runId, hiddenRepositories });
      sessions = sessions.map((item) => item.runId === current.runId
        ? { ...item, visibleRepositories: item.availableRepositories.filter((repo) => !hiddenRepositories.includes(repo)) }
        : item);
    },
    async onSaveProfile(current, profile) { savedProfile = { runId: current.runId, ...profile }; },
    async onRefresh() { cards.render(sessions); },
    toast() {},
  });

  cards.render(sessions);
  const firstCard = container.children[0];
  const editor = find(firstCard, (node) => node.tagName === 'details' && node.className === 'friday-staff-editor');
  assert.ok(editor);
  assert.equal(find(firstCard, (node) => node.tagName === 'details'), editor, 'one expandable panel contains both sections');
  assert.equal(editor.open, false, 'combined panel starts collapsed');
  assert.match(editor.textContent, /Visible repositories.*repo-a.*repo-b.*Save visibility.*Edit staff profile/s);
  const repoA = find(editor, (node) => node.tagName === 'input' && node.value === 'repo-a');
  const repoB = find(editor, (node) => node.tagName === 'input' && node.value === 'repo-b');
  assert.ok(repoA && repoB, 'both available repositories have selectable controls');
  assert.equal(repoA.checked, true);
  assert.equal(repoB.checked, true);
  assert.ok(find(editor, (node) => node.tagName === 'form' && node.className === 'friday-repo-visibility-form'));
  const initialTaskCard = container.children[1];
  const initialTaskList = find(initialTaskCard, (node) => node.className === 'friday-staff-tasks');
  assert.ok(initialTaskList);
  assert.ok(initialTaskCard.children.indexOf(find(initialTaskCard, (node) => node.className === 'friday-staff-editor')) < initialTaskCard.children.indexOf(initialTaskList));
  editor.open = true;
  const expertise = find(editor, (node) => node.tagName === 'textarea' && node.name === 'expertise');
  expertise.value = 'Unsaved expertise'; await expertise.dispatch('input'); expertise.focus();
  repoB.checked = false; await repoB.dispatch('change');

  cards.render(sessions);
  assert.equal(container.children[0], firstCard, 'unchanged polls reuse the exact session card');
  assert.equal(editor.open, true, 'expanded state survives polling');
  assert.equal(expertise.value, 'Unsaved expertise');
  assert.equal(repoB.checked, false, 'unsaved repository selection survives polling');
  assert.equal(documentRef.activeElement, expertise);

  sessions = [session('run-a', {
    workload: { openTasks: 1 },
    tasks: [{ id: 'task-1', label: 'Export', status: 'reviewing' }],
  }), sessions[1]];
  cards.render(sessions);
  assert.equal(container.children[0], firstCard, 'task updates do not replace the keyed card');
  assert.equal(editor.open, true);
  assert.equal(expertise.value, 'Unsaved expertise', 'unsaved profile input survives task/workload updates');
  assert.equal(repoB.checked, false, 'unsaved repository selection survives task/workload updates');
  assert.equal(documentRef.activeElement, expertise);
  assert.match(firstCard.textContent, /Workload: 1\/2/);
  assert.match(firstCard.textContent, /Export: reviewing/);
  assert.ok(firstCard.children.indexOf(editor) < firstCard.children.indexOf(find(firstCard, (node) => node.className === 'friday-staff-tasks')));

  const visibilityForm = find(editor, (node) => node.tagName === 'form' && node.className === 'friday-repo-visibility-form');
  await visibilityForm.dispatch('submit');
  assert.deepEqual(visibilitySaves, [{ runId: 'run-a', hiddenRepositories: ['repo-b'] }]);
  assert.equal(repoA.checked, true);
  assert.equal(repoB.checked, false, 'saved repository selection is reloaded from the server response');
  assert.equal(find(container.children[1], (node) => node.value === 'repo-b').checked, true, 'saving visibility affects only the exact run');
  repoB.checked = true; await repoB.dispatch('change');
  await visibilityForm.dispatch('submit');
  assert.deepEqual(visibilitySaves[1], { runId: 'run-a', hiddenRepositories: [] }, 'rechecking saves the repository as visible');
  assert.equal(repoB.checked, true);

  find(editor, (node) => node.name === 'responsibilities').value = 'Review changes';
  find(editor, (node) => node.name === 'capacity').value = '3';
  await find(editor, (node) => node.tagName === 'form' && node.className === 'friday-staff-profile-form').dispatch('submit');
  assert.deepEqual(savedProfile, {
    runId: 'run-a', expertise: ['Unsaved expertise'], responsibilities: ['Review changes'], capacity: 3,
  });
  assert.equal(editor.open, true, 'saving profile leaves the combined panel expanded');
  assert.equal(repoB.checked, true, 'profile refresh retains the saved repository selection');

  sessions = [session('run-a'), sessions[1]];
  cards.render(sessions);
  assert.equal(find(firstCard, (node) => node.className === 'friday-staff-tasks'), null, 'task section disappears when no active tasks remain');
  assert.equal(editor.open, true);
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
