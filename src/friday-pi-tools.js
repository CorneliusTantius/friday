import { Type } from 'typebox';

const UUID = Type.String({ format: 'uuid' });
const result = (text) => ({ content: [{ type: 'text', text }] });

export function createFridayPiTools({ listConversations, sendPrompt, getRunStatus, readConversation, deleteSession, stopRun, waitForPrompt, getConversationId, getDeleteAuthorizationContext }) {
  return [
    {
      name: 'pi_list_conversations', label: 'List conversations',
      description: 'List saved Pi Agent conversations in the selected workspace, newest first. Use a returned runId to read or send work to a conversation.',
      parameters: Type.Object({}),
      async execute() {
        const conversations = await listConversations();
        const visible = conversations.map(({ id, name, modified, messageCount, runId, running, busy, queuedPrompts }) => ({
          id, name, modified, messageCount, runId, running, busy, queuedPrompts,
        }));
        return result(JSON.stringify(visible));
      },
    },
    {
      name: 'pi_send_prompt', label: 'Queue Pi prompt',
      description: 'Queue a prompt for the Pi conversation identified by runId, or the run linked to this Friday conversation when runId is omitted. Return immediately without waiting for Pi completion.',
      parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 20000 }), runId: Type.Optional(UUID) }),
      async execute(_id, { prompt, runId }) {
        const conversationId = await getConversationId();
        const queued = await sendPrompt({ prompt, runId, conversationId });
        const run = queued?.runId ? ` for run ${queued.runId}` : '';
        const queue = queued?.queueId ? ` with queueId ${queued.queueId}` : '';
        const position = Number.isInteger(queued?.position) ? ` (queue position ${queued.position})` : '';
        return result(`Prompt queued${run}${queue}${position}. Pi completion is not awaited.`);
      },
    },
    {
      name: 'pi_wait_for_prompt', label: 'Wait for Pi prompt',
      description: 'Wait asynchronously for one specific queued Pi prompt to complete, fail, be cancelled, or time out. Use the runId and queueId returned by pi_send_prompt. Waiting never stops the Pi run.',
      parameters: Type.Object({
        runId: UUID,
        queueId: UUID,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000 })),
      }),
      async execute(_id, { runId, queueId, timeoutMs }, signal) {
        const outcome = await waitForPrompt({ runId, queueId, timeoutMs, signal });
        return result(JSON.stringify(outcome));
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
      name: 'pi_read_conversation', label: 'Read Pi conversation',
      description: 'Read the most recent messages in a listed Pi conversation. Use after checking its run status to review Pi’s reply.',
      parameters: Type.Object({ runId: UUID, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
      async execute(_id, { runId, limit }) {
        const conversation = await readConversation({ runId, limit });
        return result(conversation == null ? 'Pi conversation not found.' : JSON.stringify(conversation));
      },
    },
    {
      name: 'pi_delete_session', label: 'Delete Pi session',
      description: 'Permanently delete a saved Pi conversation. Only call after the current user explicitly requests deletion of this exact session by name or ID, or explicitly approves the preceding assistant confirmation after the task is complete. The server verifies the actual user turn and refuses current, open, active, or queued sessions.',
      parameters: Type.Object({ runId: UUID }),
      async execute(_id, { runId }) {
        const context = await getDeleteAuthorizationContext();
        const deleted = await deleteSession({ runId, conversationId: await getConversationId(), ...context });
        return result(deleted == null ? 'Pi conversation not found.' : JSON.stringify(deleted));
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
