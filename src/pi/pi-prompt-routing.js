const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveSelectedPiRun({ runId, conversationId, runRegistry }) {
  if (typeof runId !== 'string' || !UUID_RE.test(runId)) {
    const linkedRun = typeof conversationId === 'string' ? await runRegistry.getLinkedRun(conversationId) : null;
    if (!linkedRun) {
      const error = new Error('runId is required; select a Pi conversation first');
      error.status = 400;
      throw error;
    }
    runId = linkedRun.id;
  }
  const run = await runRegistry.getRun(runId);
  if (!run) {
    const error = new Error('Pi run was not found');
    error.status = 404;
    throw error;
  }
  return run;
}

export function assertPiRunAcceptsPrompt(run) {
  if (run?.closed === true || /^\[closed\](?:\s|$)/i.test(run?.name?.trim() || '')) {
    const error = new Error(`Pi session “${run.name || run.id}” is closed and cannot receive prompts`);
    error.status = 409;
    throw error;
  }
  return run;
}
