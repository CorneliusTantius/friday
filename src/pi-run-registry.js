import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPiRunRegistry({ file }) {
  if (typeof file !== 'string' || !file) throw new TypeError('file is required');
  const filename = path.resolve(file);
  const runs = new Map();
  const bySession = new Map();
  const links = new Map();
  let queue = Promise.resolve();
  let initialized = false;
  let loading;

  async function load() {
    if (initialized) return;
    if (loading) return loading;
    loading = (async () => {
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
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      initialized = true;
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
  async function persist() {
    const dir = path.dirname(filename);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ runs: [...runs.values()], links: [...links] }), { mode: 0o600 });
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
    return mutate(() => sessions.map(({ workspace, sessionPath, sessionId, name }) => {
      let id = bySession.get(sessionPath);
      if (!id) { id = randomUUID(); bySession.set(sessionPath, id); }
      runs.set(id, { id, workspace, sessionPath, sessionId, name });
      return id;
    }));
  }
  return {
    ensureRun(session) { return ensureSessions([session]).then(([id]) => id); },
    ensureRuns(sessions) { return ensureSessions(sessions); },
    async getRun(runId) { await queue; validRun(runId); await load(); return runs.get(runId) || null; },
    async listRuns() { await queue; await load(); return [...runs.values()]; },
    linkConversation(conversationId, runId) {
      validConversation(conversationId); validRun(runId);
      return mutate(() => { if (!runs.has(runId)) throw new Error('Unknown run ID'); links.set(conversationId, runId); });
    },
    async getLinkedRun(conversationId) { validConversation(conversationId); await queue; await load(); const id = links.get(conversationId); return id ? runs.get(id) || null : null; },
    unlinkConversation(conversationId) { validConversation(conversationId); return mutate(() => links.delete(conversationId)); },
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
