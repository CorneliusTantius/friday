const DIRECT_RENAME = /^\s*(?:(?:please|now)\s+)*(?:rename|retitle)\b|^\s*(?:(?:can|could|would)\s+you\s+)(?:please\s+)?(?:rename|retitle)\b/i;
const NEGATED_RENAME = /\b(?:do not|don't|never|must not|shouldn't|can't|cannot)\b.{0,64}\b(?:rename|retitle)\b/i;
const CONDITIONAL_RENAME = /\b(?:if|unless|maybe|perhaps|possibly)\b/i;
const ID_RENAME = /\b(?:rename|retitle)\b/i;
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

function requestsName(text, name) {
  const source = text.toLocaleLowerCase();
  const target = name.trim().toLocaleLowerCase();
  let offset = 0;
  while (target && (offset = source.indexOf(target, offset)) !== -1) {
    const before = source[offset - 1];
    const after = source[offset + target.length];
    const commandStart = Math.max(source.lastIndexOf('rename', offset), source.lastIndexOf('retitle', offset));
    const relation = source.slice(commandStart, offset);
    if ((!before || !NAME_CHARACTER.test(before)) && (!after || !NAME_CHARACTER.test(after)) && /\b(?:to|as|called|named)\s*["'“‘]?\s*$/i.test(relation)) return true;
    offset += target.length;
  }
  return false;
}

function mentionsExactSession(text, run, otherRuns) {
  if ([run.id, run.sessionId].some((id) => typeof id === 'string' && containsExactName(text, id))) return true;
  const name = typeof run.name === 'string' ? run.name.trim() : '';
  if (!name || otherRuns.filter((candidate) => typeof candidate.name === 'string' && candidate.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()).length !== 1) return false;
  return containsExactName(text, name);
}

export function hasExplicitPiSessionRenameAuthorization({ userMessage, run, otherRuns = [run], name }) {
  if (typeof userMessage !== 'string' || !run || typeof name !== 'string' || !name.trim()) return false;
  if (NEGATED_RENAME.test(userMessage) || CONDITIONAL_RENAME.test(userMessage) || !DIRECT_RENAME.test(userMessage) || !ID_RENAME.test(userMessage)) return false;
  return mentionsExactSession(userMessage, run, otherRuns) && requestsName(userMessage, name);
}

export function assertPiSessionRenameAuthorized(context) {
  if (hasExplicitPiSessionRenameAuthorization(context)) return;
  const error = new Error('Renaming a Pi session requires an explicit current-user request naming that exact session and its new name.');
  error.status = 403;
  throw error;
}
