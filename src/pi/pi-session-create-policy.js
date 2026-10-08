const DIRECT_CREATE = /^\s*(?:(?:yes|okay|ok)[,\s]+)?(?:now[,\s]+)*(?:(?:please|can|could|would)\s+you\s+)?(?:please\s+)?(?:create|start)\s+(?:a\s+|another\s+|new\s+)?(?:new\s+)?(?:pi\s+)?(?:agent\s+)?(?:session|conversation)\b/i;
const CREATE_NEGATION = /\b(?:do not|don't|never|must not|shouldn't|can't|cannot)\b.{0,64}\b(?:create|start)\b.{0,64}\b(?:session|conversation)\b/i;
const CREATE_CONDITIONAL = /\b(?:if|unless|maybe|perhaps|possibly)\b/i;
const HAS_TASK_PURPOSE = /\b(?:for|to handle|to work on|to complete|for routing)\b.{1,160}/i;
const SIMPLE_APPROVAL = /^\s*(?:yes(?:[,\s]+please)?|approved|confirmed|go ahead|please do|do it|proceed)[\s!.]*$/i;
const CREATE_CONFIRMATION = /\b(?:would you like me to|do you want me to|shall i|should i)\b.{0,100}\b(?:create|start)\b.{0,80}\b(?:new\s+)?(?:pi\s+)?(?:agent\s+)?(?:session|conversation)\b/i;

export function hasExplicitPiSessionCreateAuthorization({ userMessage, previousAssistantMessage = '', purpose = '' }) {
  if (typeof userMessage !== 'string' || CREATE_NEGATION.test(userMessage) || CREATE_CONDITIONAL.test(userMessage)) return false;
  if (DIRECT_CREATE.test(userMessage) && HAS_TASK_PURPOSE.test(userMessage)) return true;
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
