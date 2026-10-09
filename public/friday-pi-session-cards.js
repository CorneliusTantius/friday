export async function fetchAndRenderCurrent({ load, currentRevision, render }) {
  const revision = currentRevision();
  const value = await load();
  if (revision !== currentRevision()) return false;
  render(value);
  return true;
}

const profileFields = ['expertise', 'responsibilities', 'capacity'];
export const PI_STAFF_NAME_POOL = Object.freeze([
  'Nova', 'Atlas', 'Echo', 'Iris', 'Aether', 'Aria', 'Astra', 'Aurora', 'Cora', 'Cypher',
  'Eon', 'Juno', 'Lyra', 'Nyx', 'Orion', 'Sage', 'Sol', 'Turing', 'Vesper', 'Zenith',
]);

export function generatePiSessionName(sessions, excludeSessionPath = null) {
  const used = new Set(sessions
    .filter((session) => session.path !== excludeSessionPath)
    .map((session) => session.name?.trim().toLowerCase())
    .filter(Boolean));
  const available = (name) => !used.has(name.toLowerCase());
  const firstAvailable = PI_STAFF_NAME_POOL.find(available);
  if (firstAvailable) return firstAvailable;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${PI_STAFF_NAME_POOL[0]} ${suffix}`;
    if (available(candidate)) return candidate;
  }
}

function textLines(value) {
  return (Array.isArray(value) ? value : []).join('\n');
}

function sessionProfileValue(session, name) {
  if (name === 'capacity') return String(session.capacity || 2);
  return textLines(session[name]);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left, right) {
  const values = new Set(right);
  return left.length === values.size && left.every((value) => values.has(value));
}

export function createFridayPiSessionCards({ container, formatDate, onOpen, onSaveVisibility, onSaveProfile, onRefresh, toast, documentRef = document }) {
  const cards = new Map();
  const empty = documentRef.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = 'No Pi conversations yet';

  function createCard(session) {
    const state = {
      session,
      signature: null,
      item: documentRef.createElement('article'),
      profileDirty: new Set(),
      profileBaseline: {},
      visibilityDirty: false,
      serverVisible: [],
      visibilityInputs: new Map(),
      repoLabels: new Map(),
      repoOrder: [],
      profileInputs: {},
      taskSignature: null,
      taskList: null,
      visibilitySaving: false,
      profileSaving: false,
    };
    state.item.className = 'session-item friday-session-item';

    const open = documentRef.createElement('button');
    open.type = 'button'; open.className = 'session-open friday-session-open';
    open.addEventListener('click', () => onOpen(state.session));
    state.title = documentRef.createElement('span'); state.title.className = 'session-title';
    state.meta = documentRef.createElement('span'); state.meta.className = 'session-meta';
    open.append(state.title, state.meta);
    state.statusRow = documentRef.createElement('div'); state.statusRow.className = 'friday-session-status-row';
    state.profile = documentRef.createElement('span'); state.profile.className = 'friday-staff-workload';
    state.status = documentRef.createElement('span');
    state.statusRow.append(state.profile, state.status);

    state.editor = documentRef.createElement('details'); state.editor.className = 'friday-staff-editor';
    const editorSummary = documentRef.createElement('summary'); editorSummary.textContent = 'Staff profile and repositories'; state.editor.append(editorSummary);
    const repositorySection = documentRef.createElement('section'); repositorySection.className = 'friday-repo-context';
    const repositoryHeading = documentRef.createElement('h3'); repositoryHeading.textContent = 'Visible repositories'; repositorySection.append(repositoryHeading);
    const disclaimer = documentRef.createElement('p');
    disclaimer.textContent = 'Unchecked repositories are omitted from this session’s app-provided repo context. This is not a filesystem sandbox; host tools may still access other files.';
    repositorySection.append(disclaimer);
    state.visibilityForm = documentRef.createElement('form'); state.visibilityForm.className = 'friday-repo-visibility-form';
    state.repoOptions = documentRef.createElement('div'); state.visibilityForm.append(state.repoOptions);
    state.saveVisibility = documentRef.createElement('button'); state.saveVisibility.type = 'submit'; state.saveVisibility.className = 'button button-small'; state.saveVisibility.textContent = 'Save visibility';
    state.visibilityForm.append(state.saveVisibility);
    state.visibilityForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.visibilitySaving) return;
      const submittedVisible = [...state.visibilityInputs].filter(([, input]) => input.checked).map(([name]) => name);
      const hiddenRepositories = [...state.visibilityInputs].filter(([, input]) => !input.checked).map(([name]) => name);
      state.visibilitySaving = true; state.saveVisibility.disabled = true;
      try {
        await onSaveVisibility(state.session, hiddenRepositories);
        const currentVisible = [...state.visibilityInputs].filter(([, input]) => input.checked).map(([name]) => name);
        if (sameSet(currentVisible, submittedVisible)) {
          state.visibilityDirty = false;
          state.serverVisible = submittedVisible;
        }
        toast('Repository visibility saved for this session');
        await onRefresh();
      } catch (error) { toast(error.message, 'error'); }
      finally { state.visibilitySaving = false; state.saveVisibility.disabled = false; }
    });
    repositorySection.append(state.visibilityForm);
    state.editor.append(repositorySection);
    const profileHeading = documentRef.createElement('h3'); profileHeading.className = 'friday-profile-heading'; profileHeading.textContent = 'Edit staff profile'; state.editor.append(profileHeading);
    state.profileForm = documentRef.createElement('form'); state.profileForm.className = 'friday-staff-profile-form';
    const profileFieldsGroup = documentRef.createElement('fieldset'); profileFieldsGroup.className = 'friday-staff-profile-fields';
    const profileLegend = documentRef.createElement('legend'); profileLegend.textContent = 'Profile details';
    profileFieldsGroup.append(profileLegend);
    const labels = { expertise: 'Expertise', responsibilities: 'Responsibilities', capacity: 'Task capacity' };
    for (const name of profileFields) {
      const label = documentRef.createElement('label'); label.className = 'friday-staff-profile-field';
      const title = documentRef.createElement('span'); title.textContent = labels[name]; label.append(title);
      const input = documentRef.createElement(name === 'capacity' ? 'input' : 'textarea');
      input.name = name; input.autocomplete = 'off';
      if (name === 'capacity') { input.type = 'number'; input.min = '1'; input.max = '8'; }
      else {
        input.rows = 3;
        if (name === 'responsibilities') input.maxLength = 500;
      }
      input.addEventListener('input', () => {
        if (input.value === state.profileBaseline[name]) state.profileDirty.delete(name);
        else state.profileDirty.add(name);
      });
      state.profileInputs[name] = input;
      label.append(input);
      if (name !== 'capacity') {
        const hint = documentRef.createElement('span'); hint.className = 'friday-staff-profile-hint';
        hint.textContent = name === 'responsibilities' ? 'One per line · 500 characters total maximum' : 'Optional · one per line';
        label.append(hint);
      }
      profileFieldsGroup.append(label);
    }
    state.profileForm.append(profileFieldsGroup);
    state.saveProfile = documentRef.createElement('button'); state.saveProfile.type = 'submit'; state.saveProfile.className = 'button button-small'; state.saveProfile.textContent = 'Save profile';
    state.profileForm.append(state.saveProfile);
    state.profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.profileSaving) return;
      const submitted = Object.fromEntries(profileFields.map((name) => [name, state.profileInputs[name].value]));
      const profile = {
        expertise: submitted.expertise.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        responsibilities: submitted.responsibilities.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        capacity: Number(submitted.capacity),
      };
      state.profileSaving = true; state.saveProfile.disabled = true;
      try {
        await onSaveProfile(state.session, profile);
        for (const name of profileFields) {
          if (state.profileInputs[name].value === submitted[name]) state.profileDirty.delete(name);
          state.profileBaseline[name] = submitted[name];
        }
        toast('Pi staff profile saved');
        await onRefresh();
      } catch (error) { toast(error.message, 'error'); }
      finally { state.profileSaving = false; state.saveProfile.disabled = false; }
    });
    state.editor.append(state.profileForm);
    state.item.append(open, state.statusRow, state.editor);
    state.open = open;
    return state;
  }

  function updateRepositories(state, session) {
    const available = Array.isArray(session.availableRepositories) ? session.availableRepositories : [];
    const visible = Array.isArray(session.visibleRepositories) ? session.visibleRepositories : available;
    state.serverVisible = visible.slice();
    const availableSet = new Set(available);
    for (const [name, label] of state.repoLabels) {
      if (!availableSet.has(name)) {
        label.remove(); state.repoLabels.delete(name); state.visibilityInputs.delete(name);
      }
    }
    for (const name of available) {
      let label = state.repoLabels.get(name);
      if (!label) {
        label = documentRef.createElement('label'); label.className = 'friday-repo-visibility-item';
        const input = documentRef.createElement('input'); input.type = 'checkbox'; input.value = name; input.checked = visible.includes(name);
        input.addEventListener('change', () => {
          state.visibilityDirty = !sameSet(
            [...state.visibilityInputs].filter(([, checkbox]) => checkbox.checked).map(([repo]) => repo),
            state.serverVisible.filter((repo) => state.repoOrder.includes(repo)),
          );
        });
        const title = documentRef.createElement('span'); title.textContent = name;
        label.append(input, title); state.repoLabels.set(name, label); state.visibilityInputs.set(name, input);
      }
      const input = state.visibilityInputs.get(name);
      if (!state.visibilityDirty) input.checked = visible.includes(name);
    }
    if (!sameValues(state.repoOrder, available)) {
      available.forEach((name, index) => {
        const label = state.repoLabels.get(name);
        if (state.repoOptions.children[index] !== label) state.repoOptions.insertBefore(label, state.repoOptions.children[index] || null);
      });
      state.repoOrder = available.slice();
    }
    if (!available.length && !state.noRepositories) {
      state.noRepositories = documentRef.createElement('p'); state.noRepositories.textContent = 'No managed repositories found.';
      state.repoOptions.append(state.noRepositories);
    } else if (available.length && state.noRepositories) {
      state.noRepositories.remove(); state.noRepositories = null;
    }
  }

  function updateProfile(state, session) {
    for (const name of profileFields) {
      const nextValue = sessionProfileValue(session, name);
      const input = state.profileInputs[name];
      if (!state.profileDirty.has(name) || input.value === nextValue) {
        if (input.value !== nextValue) input.value = nextValue;
        state.profileDirty.delete(name);
      }
      state.profileBaseline[name] = nextValue;
    }
  }

  function updateCard(state, session) {
    state.session = session;
    const displayTitle = session.name || 'Untitled Pi conversation';
    state.open.title = session.preview || displayTitle;
    state.title.textContent = displayTitle;
    state.meta.textContent = `${formatDate(session.modified)} · ${session.messageCount} msg`;
    state.status.className = `session-state ${session.opening || session.busy || session.queuedPrompts ? 'working' : session.running ? 'running' : 'saved'}`;
    state.status.textContent = session.opening ? 'Opening' : session.busy ? `Working${session.queuedPrompts ? ` · ${session.queuedPrompts} queued` : ''}` : session.queuedPrompts ? `${session.queuedPrompts} queued` : session.running ? 'Open' : 'Saved';
    state.profile.textContent = `Workload: ${session.workload?.openTasks || 0}/${session.capacity || 2}`;
    updateRepositories(state, session);
    updateProfile(state, session);

    const tasks = (session.tasks || []).filter((task) => ['queued', 'running', 'reviewing', 'outcome-unknown'].includes(task.status)).slice(0, 3);
    const taskSignature = JSON.stringify(tasks);
    if (taskSignature !== state.taskSignature) {
      state.taskSignature = taskSignature;
      if (state.taskList) { state.taskList.remove(); state.taskList = null; }
      if (tasks.length) {
        state.taskList = documentRef.createElement('ul'); state.taskList.className = 'friday-staff-tasks';
        for (const task of tasks) {
          const row = documentRef.createElement('li');
          row.textContent = `${task.label}: ${task.status}${task.detail ? ` · ${task.detail}` : ''}`;
          state.taskList.append(row);
        }
        state.item.append(state.taskList);
      }
    }
    state.signature = JSON.stringify(session);
  }

  function render(sessions = []) {
    const desired = [];
    for (const session of sessions) {
      if (typeof session.runId !== 'string' || !session.runId) continue;
      let state = cards.get(session.runId);
      if (!state) {
        state = createCard(session);
        cards.set(session.runId, state);
      }
      if (state.signature !== JSON.stringify(session)) updateCard(state, session);
      else state.session = session;
      desired.push(state.item);
    }
    const keep = new Set(desired);
    for (const [runId, state] of cards) {
      if (keep.has(state.item)) continue;
      state.item.remove(); cards.delete(runId);
    }
    if (!desired.length) {
      if (container.children.length !== 1 || container.children[0] !== empty) container.replaceChildren(empty);
      return;
    }
    empty.remove();
    if (container.children.length !== desired.length || desired.some((item, index) => container.children[index] !== item)) {
      desired.forEach((item, index) => {
        if (container.children[index] !== item) container.insertBefore(item, container.children[index] || null);
      });
    }
  }

  return { render };
}
