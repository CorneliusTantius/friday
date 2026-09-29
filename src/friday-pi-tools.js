import { Type } from 'typebox';

const UUID = Type.String({ format: 'uuid' });
const result = (text) => ({ content: [{ type: 'text', text }] });

export function createFridayPiTools({ listConversations, sendPrompt, getRunStatus, stopRun, getConversationId }) {
  return [
    {
      name: 'pi_list_conversations', label: 'List conversations',
      description: 'List available conversations.',
      parameters: Type.Object({}),
      async execute() {
        const conversations = await listConversations();
        return result(JSON.stringify(conversations));
      },
    },
    {
      name: 'pi_send_prompt', label: 'Queue Pi prompt',
      description: 'Queue a prompt for Pi and return immediately; this does not wait for Pi completion.',
      parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 20000 }), runId: Type.Optional(UUID) }),
      async execute(_id, { prompt, runId }) {
        const conversationId = await getConversationId();
        const queued = await sendPrompt({ prompt, runId, conversationId });
        const run = queued?.runId ? ` for run ${queued.runId}` : '';
        const position = Number.isInteger(queued?.position) ? ` (queue position ${queued.position})` : '';
        return result(`Prompt queued${run}${position}. Pi completion is not awaited.`);
      },
    },
    {
      name: 'pi_run_status', label: 'Pi run status',
      description: 'Get the status of a Pi run.',
      parameters: Type.Object({ runId: UUID }),
      async execute(_id, { runId }) {
        const status = await getRunStatus(runId);
        return result(status == null ? 'Run not found.' : JSON.stringify(status));
      },
    },
    {
      name: 'pi_stop_run', label: 'Stop Pi run',
      description: 'Stop the running Pi response and discard its queued prompts. Only use when the user explicitly asks to stop it.',
      parameters: Type.Object({ runId: UUID }),
      async execute(_id, { runId }) {
        const status = await stopRun(runId);
        return result(status == null ? 'Run not found.' : JSON.stringify(status));
      },
    },
  ];
}
