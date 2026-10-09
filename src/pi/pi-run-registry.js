import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_STAFF_CAPACITY = 2;
const STALE_COMPLETED_REVIEW_DETAIL = 'Pi finished; Friday is checking the result against the original request.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isClosedName = (name) => typeof name === 'string' && /^\[closed\](?:\s|$)/i.test(name.trim());

export function createPiRunRegistry({ file, onRecovery = () => {} }) {
  if (typeof file !== 'string' || !file) throw new TypeError('file is required');
  const filename = path.resolve(file);
  const runs = new Map();
  const bySession = new Map();
  const links = new Map();
  const tasks = new Map();
  const currentTasks = new Map();
  const taskStatuses = new Set(['queued', 'running', 'reviewing', 'completed', 'blocked', 'outcome-unknown']);
  let queue = Promise.resolve();
  let initialized = false;
  let loading;

  async function load() {
    if (initialized) return;
    if (loading) return loading;
    loading = (async () => {
      const recovered = [];
      try {
        const data = JSON.parse(await fs.readFile(filename, 'utf8'));
        for (const run of data.runs || []) {
          if (!run || !UUID_RE.test(run.id) || typeof run.sessionPath !== 'string') continue;
          runs.set(run.id, run);
          bySession.set(run.sessionPath, run.id);
        }
        for (const [conversationId, runId] of data.links || []) {
          if (validConversation(conversationId) && runs.has(runId)) links.set(conversationId, runId);
        }
        for (const task of data.tasks || []) {
          if (!task || !UUID_RE.test(task.id) || !UUID_RE.test(task.runId) || typeof task.conversationId !== 'string' || !taskStatuses.has(task.status)) continue;
          if (['queued', 'running', 'reviewing'].includes(task.status)) {
            const previousStatus = task.status;
            task.status = 'outcome-unknown';
            task.detail = previousStatus === 'reviewing'
              ? 'Friday restarted during review; outcome is unknown and Pi work was not replayed.'
              : 'Friday restarted before the task was confirmed complete.';
            if (previousStatus === 'reviewing') {
              task.review = { ...task.review, stage: 'interrupted', interruptedAt: new Date().toISOString(), errorCode: 'process_restarted' };
            }
            task.updatedAt = new Date().toISOString();
            recovered.push({ taskId: task.id, runId: task.runId, queueId: task.queueId, previousStatus });
          }
          tasks.set(task.id, task);
        }
        for (const [conversationId, taskId] of data.currentTasks || []) {
          if (typeof conversationId === 'string' && tasks.has(taskId)) currentTasks.set(conversationId, taskId);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      initialized = true;
      if (recovered.length) {
        await persist();
        for (const entry of recovered) onRecovery(entry);
      }
    })();
    try {
      await loading;
    } finally {
      loading = undefined;
    }
  }
  function validConversation(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f/\\]/.test(id)) throw new TypeError('Invalid conversation ID');
  }
  function validRun(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('Invalid run ID');
  }
  function snapshot() {
    return { runs: [...runs.values()], links: [...links], tasks: [...tasks.values()], currentTasks: [...currentTasks] };
  }
  async function persist() {
    const dir = path.dirname(filename);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(snapshot()), { mode: 0o600 });
      await fs.rename(temporary, filename);
      await fs.chmod(filename, 0o600);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  function mutate(fn) {
    const result = queue.then(async () => { await load(); const value = fn(); await persist(); return value; });
    queue = result.catch(() => {});
    return result;
  }
  function ensureSessions(sessions) {
    if (!Array.isArray(sessions)) throw new TypeError('sessions must be an array');
    for (const session of sessions) {
      if (!session || typeof session.sessionPath !== 'string' || !session.sessionPath) throw new TypeError('sessionPath is required');
    }
    return mutate(() => sessions.map(({ workspace, sessionPath, sessionId, name, domain, purpose }) => {
      let id = bySession.get(sessionPath);
      if (!id) { id = randomUUID(); bySession.set(sessionPath, id); }
      const previous = runs.get(id);
      const run = { ...previous, id, workspace, sessionPath, sessionId, name };
      if (!previous) run.capacity = DEFAULT_STAFF_CAPACITY;
      if (isClosedName(name)) run.closed = true;
      else if (previous?.closed !== true) run.closed = false;
      if (typeof domain === 'string' && domain.trim()) run.domain = domain.trim();
      if (typeof purpose === 'string' && purpose.trim()) run.purpose = purpose.trim();
      runs.set(id, run);
      return id;
    }));
  }
  return {
    ensureRun(session) { return ensureSessions([session]).then(([id]) => id); },
    ensureRuns(sessions) { return ensureSessions(sessions); },
    async getRun(runId) { await queue; validRun(runId); await load(); return runs.get(runId) || null; },
    async listRuns() { await queue; await load(); return [...runs.values()]; },
    async listTasks({ conversationId, runId } = {}) {
      if (conversationId !== undefined) validConversation(conversationId);
      if (runId !== undefined) validRun(runId);
      await queue; await load();
      return [...tasks.values()]
        .filter((task) => (conversationId === undefined || task.conversationId === conversationId) && (runId === undefined || task.runId === runId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    updateRunNavigationLabel(runId, label) {
      validRun(runId);
      if (label !== null && (typeof label !== 'string' || label.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(label))) throw new TypeError('Invalid Pi navigation label');
      const navigationLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
      return mutate(() => {
        const run = runs.get(runId);
        if (!run) return null;
        const updated = { ...run, navigationLabel };
        runs.set(runId, updated);
        return updated;
      });
    },
    updateRunRepositoryVisibility(runId, hiddenRepositories) {
      validRun(runId);
      if (!Array.isArray(hiddenRepositories) || hiddenRepositories.length > 500 || hiddenRepositories.some((name) => typeof name !== 'string' || !name.trim() || name.trim().length > 100)) throw new TypeError('Invalid repository visibility');
      return mutate(() => {
        const run = runs.get(runId);
        if (!run) return null;
        const updated = { ...run, hiddenRepositories: [...new Set(hiddenRepositories.map((name) => name.trim()))] };
        runs.set(runId, updated);
        return updated;
      });
    },
    updateRunProfile(runId, profile) {
      validRun(runId);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError('Invalid Pi staff profile');
      for (const key of ['expertise', 'responsibilities']) {
        const values = profile[key];
        if (!Array.isArray(values) || values.length > 12 || values.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 100)) throw new TypeError(`Invalid Pi profile ${key}`);
      }
      const uniqueResponsibilities = [...new Set(profile.responsibilities.map((item) => item.trim()))];
      if (uniqueResponsibilities.reduce((total, item) => total + item.length, 0) > 500) throw new TypeError('Invalid Pi profile responsibilities');
      if (!Number.isInteger(profile.capacity) || profile.capacity < 1 || profile.capacity > 8) throw new TypeError('Invalid Pi profile capacity');
      return mutate(() => {
        const run = runs.get(runId);
        if (!run) return null;
        const updated = {
          ...run,
          expertise: [...new Set(profile.expertise.map((item) => item.trim()))],
          responsibilities: [...new Set(profile.responsibilities.map((item) => item.trim()))],
          capacity: profile.capacity,
        };
        runs.set(runId, updated);
        return updated;
      });
    },
    linkConversation(conversationId, runId) {
      validConversation(conversationId); validRun(runId);
      return mutate(() => { if (!runs.has(runId)) throw new Error('Unknown run ID'); links.set(conversationId, runId); });
    },
    async getLinkedRun(conversationId) { validConversation(conversationId); await queue; await load(); const id = links.get(conversationId); return id ? runs.get(id) || null : null; },
    unlinkConversation(conversationId) { validConversation(conversationId); return mutate(() => links.delete(conversationId)); },
    createTask({ id = randomUUID(), conversationId, runId, label, queueId = null }) {
      validConversation(conversationId); validRun(runId);
      if (!UUID_RE.test(id) || typeof label !== 'string' || !label.trim() || label.trim().length > 100) throw new TypeError('Invalid task');
      if (queueId !== null && !UUID_RE.test(queueId)) throw new TypeError('Invalid task queueId');
      return mutate(() => {
        const now = new Date().toISOString();
        const task = { id, conversationId, runId, label: label.trim(), queueId, status: 'queued', createdAt: now, updatedAt: now };
        tasks.set(id, task);
        currentTasks.set(conversationId, id);
        return task;
      });
    },
    async getTask(taskId) { await queue; if (!UUID_RE.test(taskId)) throw new TypeError('Invalid task ID'); await load(); return tasks.get(taskId) || null; },
    async getTaskForPrompt(runId, queueId) {
      await queue; validRun(runId); if (!UUID_RE.test(queueId)) throw new TypeError('Invalid queue ID'); await load();
      return [...tasks.values()].find((task) => task.runId === runId && task.queueId === queueId) || null;
    },
    async getTaskForQueue(queueId) {
      if (!UUID_RE.test(queueId)) throw new TypeError('Invalid queue ID');
      await queue; await load();
      return [...tasks.values()].find((task) => task.queueId === queueId) || null;
    },
    async getCurrentTask(conversationId) {
      validConversation(conversationId); await queue; await load();
      const taskId = currentTasks.get(conversationId);
      return taskId ? tasks.get(taskId) || null : null;
    },
    clearCurrentTask(conversationId) {
      validConversation(conversationId);
      return mutate(() => currentTasks.delete(conversationId));
    },
    clearStaleCompletedReviewDetails(backupFile) {
      if (typeof backupFile !== 'string' || !backupFile || path.resolve(backupFile) === filename) throw new TypeError('A separate backup file is required');
      const result = queue.then(async () => {
        await load();
        const matching = [...tasks.values()].filter((task) => task.status === 'completed' && task.detail === STALE_COMPLETED_REVIEW_DETAIL);
        if (!matching.length) return { count: 0, taskIds: [], backupFile: null };
        const original = await fs.readFile(filename, 'utf8');
        if (original !== JSON.stringify(snapshot())) throw new Error('Registry changed outside this process; refusing cleanup');
        await fs.writeFile(backupFile, original, { flag: 'wx', mode: 0o600 });
        await fs.chmod(backupFile, 0o600);
        const before = matching.map((task) => ({ task, detail: task.detail }));
        for (const { task } of before) delete task.detail;
        try {
          await persist();
          const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
          const savedById = new Map(saved.tasks.map((task) => [task.id, task]));
          if (before.some(({ task }) => savedById.get(task.id)?.status !== 'completed' || savedById.get(task.id)?.detail === STALE_COMPLETED_REVIEW_DETAIL)) {
            throw new Error('Registry cleanup verification failed');
          }
        } catch (error) {
          for (const { task, detail } of before) task.detail = detail;
          throw error;
        }
        return { count: matching.length, taskIds: matching.map((task) => task.id), backupFile };
      });
      queue = result.catch(() => {});
      return result;
    },
    updateTask(taskId, { status, detail, summary, queueId, review } = {}) {
      if (!UUID_RE.test(taskId) || !taskStatuses.has(status)) throw new TypeError('Invalid task update');
      if (review !== undefined) {
        const allowed = new Set(['queued', 'active', 'finished', 'failed', 'queue-full', 'interrupted']);
        const fields = new Set(['stage', 'queuedAt', 'startedAt', 'finishedAt', 'interruptedAt', 'errorCode']);
        if (!review || typeof review !== 'object' || Array.isArray(review) || Object.keys(review).some((key) => !fields.has(key))) throw new TypeError('Invalid task review state');
        if (!allowed.has(review.stage)) throw new TypeError('Invalid task review stage');
        for (const key of ['queuedAt', 'startedAt', 'finishedAt', 'interruptedAt']) {
          if (review[key] !== undefined && (typeof review[key] !== 'string' || !Number.isFinite(Date.parse(review[key])))) throw new TypeError('Invalid task review timestamp');
        }
        if (review.errorCode !== undefined && review.errorCode !== null && (typeof review.errorCode !== 'string' || !/^[a-z_]{1,48}$/.test(review.errorCode))) throw new TypeError('Invalid task review error code');
      }
      if (queueId !== undefined && queueId !== null && !UUID_RE.test(queueId)) throw new TypeError('Invalid task queueId');
      for (const value of [detail, summary]) if (value !== undefined && (typeof value !== 'string' || value.length > 1000)) throw new TypeError('Invalid task detail');
      return mutate(() => {
        const task = tasks.get(taskId);
        if (!task) return null;
        const transitions = {
          queued: new Set(['running', 'reviewing', 'blocked', 'outcome-unknown']),
          running: new Set(['reviewing', 'blocked', 'outcome-unknown']),
          reviewing: new Set(['completed', 'blocked']),
          'outcome-unknown': new Set(['reviewing', 'blocked']),
          blocked: new Set(['blocked']),
          completed: new Set(['completed']),
        };
        if (task.status !== status && !transitions[task.status]?.has(status)) return task;
        task.status = status;
        if (detail !== undefined) task.detail = detail;
        if (summary !== undefined) task.summary = summary;
        if (summary !== undefined && ['completed', 'blocked'].includes(status)) delete task.detail;
        if (review !== undefined) task.review = { ...task.review, ...review };
        if (queueId !== undefined) task.queueId = queueId;
        task.updatedAt = new Date().toISOString();
        return task;
      });
    },
    updateTasksForRun(runId, status, detail) {
      validRun(runId);
      if (!taskStatuses.has(status)) throw new TypeError('Invalid task status');
      return mutate(() => {
        const updated = [];
        for (const task of tasks.values()) if (task.runId === runId && !['completed', 'blocked'].includes(task.status)) {
          task.status = status; task.detail = detail; task.updatedAt = new Date().toISOString(); updated.push(task);
        }
        return updated;
      });
    },
    renameRun(runId, name) {
      validRun(runId);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new TypeError('Invalid run name');
      return mutate(() => {
        const run = runs.get(runId);
        if (!run) return null;
        const updated = { ...run, name: name.trim(), closed: isClosedName(name) };
        runs.set(runId, updated);
        return updated;
      });
    },
    deleteRun(runId) {
      validRun(runId);
      return mutate(() => {
        const run = runs.get(runId);
        if (!run) return false;
        runs.delete(runId);
        bySession.delete(run.sessionPath);
        for (const [conversationId, linkedRunId] of links) {
          if (linkedRunId === runId) links.delete(conversationId);
        }
        return true;
      });
    },
  };
}
