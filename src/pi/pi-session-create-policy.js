const DIRECT_CREATE_LEAD = /^(?:yes[\s,]+)?(?:now\s+)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+|i(?:'d| would)\s+like\s+you\s+to\s+)?(?:please\s+)?(?:create|make|start)\b/i;
const CREATE_TARGET = /\b(?:session|conversation|staff(?:\s+member)?)\b/i;
const CREATE_NEGATION = /\b(?:do not|don't|never|must not|shouldn't|can't|cannot)\b.{0,100}\b(?:create|make|start)\b.{0,100}\b(?:session|conversation|staff)\b/i;
const CREATE_CONDITIONAL = /\b(?:if|unless|maybe|perhaps|possibly)\b/i;
const INDIRECT_OBJECT = /\b(?:ability|button|capability|feature|function|option|policy|tool|guide|tutorial|documentation|instructions?|manual|plan|explanation|steps|overview|example|template)\b/i;
const SIMPLE_APPROVAL = /^\s*(?:yes(?:[,\s]+please)?|approved|confirmed|go ahead|please do|do it|proceed)[\s!.]*$/i;
const CREATE_CONFIRMATION = /^\s*(?:(?:no|there is no)[^.?!]{0,180}\.\s*)?(?:would you like me to|do you want me to|shall i)\s+(?:create|make|start)\b[^?]*\b(?:staff|session|conversation)\b[^?]*\?\s*$/i;

function hasDirectCreateRequest(userMessage) {
  if (CREATE_NEGATION.test(userMessage) || CREATE_CONDITIONAL.test(userMessage)) return false;

  // Recognize commands within compound user turns, but not quoted or reported instructions.
  const clauses = userMessage.split(/[.!?;]+|\b(?:and|then|also|but)\b/i);
  return clauses.some((clause) => {
    const text = clause.trim();
    if (!text || /^["'“‘`]/.test(text)) return false;
    const lead = DIRECT_CREATE_LEAD.exec(text);
    if (!lead) return false;
    const target = CREATE_TARGET.exec(text.slice(lead[0].length));
    if (!target || target.index > 90) return false;
    return !INDIRECT_OBJECT.test(text.slice(lead[0].length, lead[0].length + target.index));
  });
}

export function hasExplicitPiSessionCreateAuthorization({ userMessage, previousAssistantMessage = '', purpose = '' }) {
  if (typeof userMessage !== 'string') return false;
  if (hasDirectCreateRequest(userMessage)) return true;
  return SIMPLE_APPROVAL.test(userMessage)
    && typeof previousAssistantMessage === 'string'
    && typeof purpose === 'string'
    && purpose.trim().length > 0
    && previousAssistantMessage.toLocaleLowerCase().includes(purpose.trim().toLocaleLowerCase())
    && CREATE_CONFIRMATION.test(previousAssistantMessage);
}

export function assertPiSessionCreateAuthorized(context) {
  if (hasExplicitPiSessionCreateAuthorization(context)) return;
  const error = new Error('Creating a Pi session requires the current user to explicitly authorize a new session for this work.');
  error.status = 403;
  throw error;
}
