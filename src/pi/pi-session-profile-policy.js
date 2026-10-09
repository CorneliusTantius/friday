const DIRECT_PROFILE_UPDATE = /^\s*(?:(?:yes|okay|ok)[,\s]+)?(?:(?:please|now)\s+)*(?:update|set|edit|change|configure)\b/i;
const NEGATED_PROFILE_UPDATE = /\b(?:do not|don't|never|must not|shouldn't|can't|cannot)\b.{0,80}\b(?:update|set|edit|change|configure|profile|expertise|responsibilit|repository|capacity|ownership)\b/i;
const CONDITIONAL_PROFILE_UPDATE = /\b(?:if|unless|maybe|perhaps|possibly)\b/i;
const NAME_CHARACTER = /[\p{L}\p{N}_-]/u;

function containsExactName(text, name) {
  const source = text.toLocaleLowerCase();
  const target = name.trim().toLocaleLowerCase();
  let offset = 0;
  while (target && (offset = source.indexOf(target, offset)) !== -1) {
    const before = source[offset - 1];
    const after = source[offset + target.length];
    if ((!before || !NAME_CHARACTER.test(before)) && (!after || !NAME_CHARACTER.test(after))) return true;
    offset += target.length;
  }
  return false;
}

export function hasExplicitPiSessionProfileAuthorization({ userMessage, run, otherRuns = [run] }) {
  if (typeof userMessage !== 'string' || !run) return false;
  if (NEGATED_PROFILE_UPDATE.test(userMessage) || CONDITIONAL_PROFILE_UPDATE.test(userMessage) || !DIRECT_PROFILE_UPDATE.test(userMessage)) return false;
  if ([run.id, run.sessionId].some((id) => typeof id === 'string' && containsExactName(userMessage, id))) return true;
  const name = typeof run.name === 'string' ? run.name.trim() : '';
  if (!name || !Array.isArray(otherRuns)) return false;
  const normalized = name.toLocaleLowerCase();
  const matchingRuns = otherRuns.filter((candidate) => {
    const candidateName = typeof candidate.name === 'string' ? candidate.name.trim().toLocaleLowerCase() : '';
    return candidateName && (containsExactName(candidateName, normalized)
      || containsExactName(normalized, candidateName));
  });
  const sameRun = matchingRuns.length === 1 && (matchingRuns[0] === run
    || (typeof run.id === 'string' && matchingRuns[0].id === run.id)
    || (typeof run.runId === 'string' && matchingRuns[0].runId === run.runId));
  if (!sameRun) return false;
  return containsExactName(userMessage, name);
}

export function assertPiSessionProfileAuthorized(context) {
  if (hasExplicitPiSessionProfileAuthorization(context)) return;
  const error = new Error('Updating a Pi staff profile requires an explicit current-user request naming that exact session.');
  error.status = 403;
  throw error;
}
