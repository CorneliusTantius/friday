const STOP_REQUEST = /^\s*(?:please\s+)?(?:stop|cancel|abort)\b|^\s*(?:can|could|would)\s+you\s+(?:please\s+)?(?:stop|cancel|abort)\b|^\s*i\s+(?:explicitly\s+)?(?:request|want|need)\s+you\s+to\s+(?:stop|cancel|abort)\b/i;
const NEGATED_STOP = /\b(?:do not|don't|never|must not|shouldn't|can't|cannot)\b.{0,48}\b(?:stop|cancel|abort)\b/i;

function mentionsTarget(text, run, otherRuns) {
  const normalized = text.toLocaleLowerCase();
  if ([run.id, run.sessionId].some((target) => typeof target === 'string' && target.length >= 3 && normalized.includes(target.toLocaleLowerCase()))) return true;
  const name = typeof run.name === 'string' ? run.name.trim().toLocaleLowerCase() : '';
  return Boolean(name && normalized.includes(name)
    && otherRuns.filter((candidate) => candidate.name?.trim().toLocaleLowerCase() === name).length === 1);
}

export function hasExplicitPiRunStopAuthorization({ userMessage, run, otherRuns = [run] }) {
  return typeof userMessage === 'string'
    && run
    && !NEGATED_STOP.test(userMessage)
    && STOP_REQUEST.test(userMessage)
    && mentionsTarget(userMessage, run, otherRuns);
}

export function assertPiRunStopAuthorized(context) {
  if (hasExplicitPiRunStopAuthorization(context)) return;
  const error = new Error('Stopping a Pi run requires an explicit current-user request naming that run.');
  error.status = 403;
  throw error;
}
