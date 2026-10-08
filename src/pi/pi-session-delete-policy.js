const DELETE_VERBS = /\b(?:delete|remove|erase|discard)\b/i;
const DIRECT_DELETE_REQUEST = /^\s*(?:please\s+)?(?:delete|remove|erase|discard)\b|^\s*(?:yes|okay|ok|confirmed|approved)[,!\s]+(?:please\s+)?(?:delete|remove|erase|discard)\b|^\s*(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:delete|remove|erase|discard)\b|^\s*i(?:\s+explicitly)?\s+(?:request|want|need)\s+you\s+to\s+(?:delete|remove|erase|discard)\b/i;
const NEGATED_DELETE = /\b(?:do not|don't|never|must not|shouldn't|can't|cannot)\b.{0,48}\b(?:delete|remove|erase|discard)\b/i;
const SIMPLE_APPROVAL = /^\s*(?:yes(?:[,\s]+please|[,\s]+delete it)?|approved?|confirmed?|go ahead(?: and delete it)?|please do|do it|proceed|delete it)[\s!.]*$/i;
const TASK_COMPLETE = /\b(?:task|work|request|implementation)\b.{0,80}\b(?:complete(?:d)?|finished|done)\b|\b(?:complete(?:d)?|finished|done)\b.{0,80}\b(?:task|work|request|implementation)\b/i;
const APPROVAL_QUESTION = /\b(?:should i|shall i|would you like me to|do you want me to|do you approve|please confirm|say yes|reply yes)\b/i;

function mentionsTarget(text, run, otherRuns) {
  const normalized = text.toLocaleLowerCase();
  if ([run.id, run.sessionId].some((target) => typeof target === 'string' && target.length >= 3 && normalized.includes(target.toLocaleLowerCase()))) return true;
  const name = typeof run.name === 'string' ? run.name.trim().toLocaleLowerCase() : '';
  if (!name || !normalized.includes(name)) return false;
  return otherRuns.filter((candidate) => candidate.name?.trim().toLocaleLowerCase() === name).length === 1;
}

export function hasExplicitPiSessionDeleteAuthorization({ userMessage, previousAssistantMessage, run, otherRuns = [run] }) {
  if (typeof userMessage !== 'string' || !run || NEGATED_DELETE.test(userMessage)) return false;
  if (DIRECT_DELETE_REQUEST.test(userMessage) && mentionsTarget(userMessage, run, otherRuns)) return true;
  return SIMPLE_APPROVAL.test(userMessage)
    && typeof previousAssistantMessage === 'string'
    && mentionsTarget(previousAssistantMessage, run, otherRuns)
    && DELETE_VERBS.test(previousAssistantMessage)
    && TASK_COMPLETE.test(previousAssistantMessage)
    && APPROVAL_QUESTION.test(previousAssistantMessage);
}

export function assertPiSessionDeleteAuthorized({ userMessage, previousAssistantMessage, run, otherRuns = [run] }) {
  if (hasExplicitPiSessionDeleteAuthorization({ userMessage, previousAssistantMessage, run, otherRuns })) return;
  const error = new Error('Deletion requires an explicit user request for this exact Pi conversation, or explicit approval after the task is complete.');
  error.status = 403;
  throw error;
}

export async function deletePiSessionWithPolicy({ runId, run, otherRuns, userMessage, previousAssistantMessage, linkedRunId, opening, runtimes, remove }) {
  assertPiSessionDeleteAuthorized({ userMessage, previousAssistantMessage, run, otherRuns });
  assertPiSessionDeletable({ runId, linkedRunId, opening, runtimes });
  return remove();
}

export function assertPiSessionDeletable({ runId, linkedRunId, opening = false, runtimes = [] }) {
  if (linkedRunId === runId) {
    const error = new Error('Cannot delete the Pi conversation linked to the current Friday conversation.');
    error.status = 409;
    throw error;
  }
  if (opening || runtimes.some(({ pi }) => pi.hasActiveWork || pi.promptQueue?.length || pi.processingPromptQueue)) {
    const error = new Error('Cannot delete a Pi conversation while it is opening, running, or has queued prompts.');
    error.status = 409;
    throw error;
  }
  if (runtimes.length) {
    const error = new Error('Cannot delete a Pi conversation that is open in a Pi runtime. Switch or close it first.');
    error.status = 409;
    throw error;
  }
}
