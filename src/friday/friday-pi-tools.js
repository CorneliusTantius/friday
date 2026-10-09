import { Type } from 'typebox';
import { DEFAULT_STAFF_CAPACITY } from '../pi/pi-run-registry.js';
import { Value } from 'typebox/value';

const UUID = Type.String({ format: 'uuid' });
const result = (text) => ({ content: [{ type: 'text', text }] });
const strictObject = (properties) => Type.Object(properties, { additionalProperties: false });
const invalidArguments = (name) => new TypeError(`Invalid ${name} parameters`);
const validate = (schema, args, name) => {
  if (!Value.Check(schema, args)) throw invalidArguments(name);
  return args;
};
const validateAction = (schemas, args, name) => {
  const schema = args && typeof args === 'object' ? schemas[args.action] : null;
  if (!schema || !Value.Check(schema, args)) throw invalidArguments(name);
  return args;
};

// Pi's constrained-schema path requires an object root and rejects object-valued anyOf.
// Expose an object with a discriminant, then validate the matching strict object branch here.
const listAction = strictObject({ action: Type.Literal('list') });
const statusAction = strictObject({ action: Type.Literal('status'), runId: UUID });
const readAction = strictObject({
  action: Type.Literal('read'),
  runId: UUID,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  taskId: Type.Optional(UUID),
});
const sessionsActions = { list: listAction, status: statusAction, read: readAction };
const sessionsParameters = strictObject({
  action: Type.Union([Type.Literal('list'), Type.Literal('status'), Type.Literal('read')], { description: 'list reads the workspace list; status/read require runId.' }),
  runId: Type.Optional(Type.String({ format: 'uuid', description: 'Required for status and read; never inferred from conversation context.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'For read only; at most 10 recent messages.' })),
  taskId: Type.Optional(Type.String({ format: 'uuid', description: 'For manual recovery only: exact task ID from the task roster.' })),
});

const createAction = strictObject({
  action: Type.Literal('create'),
  purpose: Type.String({ minLength: 1, maxLength: 100 }),
  domain: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});
const renameAction = strictObject({
  action: Type.Literal('rename'),
  runId: UUID,
  name: Type.String({ minLength: 1, maxLength: 100, description: 'New concise single-line name.' }),
});
const deleteAction = strictObject({ action: Type.Literal('delete'), runId: UUID });
const profileAction = strictObject({
  action: Type.Literal('profile'), runId: UUID,
  expertise: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 12 }),
  responsibilities: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 12 }),
  repositories: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 12 }),
  capacity: Type.Integer({ minimum: 1, maximum: 8 }),
});
const manageActions = { create: createAction, rename: renameAction, delete: deleteAction, profile: profileAction };
const manageParameters = strictObject({
  action: Type.Union([Type.Literal('create'), Type.Literal('rename'), Type.Literal('delete'), Type.Literal('profile')], { description: 'Select exactly one session action; the server applies that action’s own authorization policy.' }),
  purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Required only for create.' })),
  domain: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'Optional for create only.' })),
  runId: Type.Optional(Type.String({ format: 'uuid', description: 'Required for rename and delete; never inferred from conversation context.' })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: 'Required only for rename.' })),
  expertise: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 12 })),
  responsibilities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 12 })),
  repositories: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 12 })),
  capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});

export function createFridayPiTools({ listConversations, createSession, renameSession, sendPrompt, reportTask, getRunStatus, readConversation, deleteSession, updateProfile, stopRun, getConversationId, getCreateAuthorizationContext, getRenameAuthorizationContext, getProfileAuthorizationContext, getStopAuthorizationContext, getDeleteAuthorizationContext }) {
  const taskPromptParameters = strictObject({
    taskName: Type.String({ minLength: 1, maxLength: 100 }),
    prompt: Type.String({ minLength: 1, maxLength: 20000 }),
    runId: UUID,
  });
  const reportParameters = strictObject({
    taskId: UUID,
    status: Type.Union([Type.Literal('completed'), Type.Literal('blocked')]),
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
  });
  const stopParameters = strictObject({ runId: UUID });

  return [
    {
      name: 'pi_sessions', label: 'Pi sessions',
      description: 'Read Pi conversations without changing them. Use action=list to inspect current-workspace sessions, optional user-set displayName aliases, their live status, and visibleRepositories (the app-provided repo context; not a filesystem sandbox). repositories is separate staff-fit metadata. action=status or action=read requires the exact runId from the list. Read returns at most 10 recent messages. A runId is never inferred; aliases are labels only, and duplicate/matching aliases require user clarification rather than a guess.',
      parameters: sessionsParameters,
      async execute(_id, rawArgs) {
        const args = validateAction(sessionsActions, rawArgs, 'pi_sessions');
        if (args.action === 'list') {
          const conversations = await listConversations();
          const visible = conversations.map(({ id, name, displayName, domain, purpose, modified, messageCount, runId, running, busy, queuedPrompts, expertise, responsibilities, repositories, visibleRepositories, capacity, workload, tasks }) => {
            const visibleRepositoryList = Array.isArray(visibleRepositories) ? visibleRepositories : repositories || [];
            return {
              id, name, displayName: displayName || null, domain, purpose, modified, messageCount, runId, running, busy, queuedPrompts,
              expertise: expertise || [], responsibilities: responsibilities || [], repositories: repositories || [],
              visibleRepositories: visibleRepositoryList, capacity: capacity ?? DEFAULT_STAFF_CAPACITY,
              workload: workload || { openTasks: 0 }, tasks: tasks || [],
            };
          });
          return result(JSON.stringify(visible));
        }
        if (args.action === 'status') {
          const status = await getRunStatus(args.runId);
          return result(status == null ? 'Run not found.' : JSON.stringify(status));
        }
        const conversation = await readConversation({ runId: args.runId, limit: args.limit, taskId: args.taskId, conversationId: await getConversationId() });
        return result(conversation == null ? 'Pi conversation not found.' : JSON.stringify(conversation));
      },
    },
    {
      name: 'pi_manage_session', label: 'Manage Pi session',
      description: 'Create, rename, delete, or update the staff profile for a Pi session. Each action has its own authorization; profile updates require an explicit current-user request naming the exact session. Does not select or switch sessions. Delete is refused for current, linked, open, active, or queued sessions.',
      parameters: manageParameters,
      async execute(_id, rawArgs) {
        const args = validateAction(manageActions, rawArgs, 'pi_manage_session');
        if (args.action === 'create') {
          const authorization = await getCreateAuthorizationContext();
          const session = await createSession({ purpose: args.purpose, domain: args.domain, ...authorization });
          return result(JSON.stringify(session));
        }
        if (args.action === 'rename') {
          const authorization = await getRenameAuthorizationContext();
          const session = await renameSession({ runId: args.runId, name: args.name, ...authorization });
          return result(session == null ? 'Pi conversation not found.' : JSON.stringify(session));
        }
        if (args.action === 'profile') {
          const authorization = await getProfileAuthorizationContext();
          const updated = await updateProfile({
            runId: args.runId,
            profile: { expertise: args.expertise, responsibilities: args.responsibilities, repositories: args.repositories, capacity: args.capacity },
            ...authorization,
          });
          return result(updated == null ? 'Pi conversation not found.' : JSON.stringify(updated));
        }
        const authorization = await getDeleteAuthorizationContext();
        const deleted = await deleteSession({ runId: args.runId, conversationId: await getConversationId(), ...authorization });
        return result(deleted == null ? 'Pi conversation not found.' : JSON.stringify(deleted));
      },
    },
    {
      name: 'pi_send_prompt', label: 'Queue Pi prompt',
      description: 'Queue structured work only for the explicitly selected Pi conversation identified by its exact runId from pi_sessions(action=list). Check its profile and open-task workload first. Include a concise taskName and a prompt with objective, acceptance checks, and constraints. Returns immediately; Friday automatically reviews a live completion event. Never wait or resend an unknown task.',
      parameters: taskPromptParameters,
      async execute(_id, rawArgs) {
        const { taskName, prompt, runId } = validate(taskPromptParameters, rawArgs, 'pi_send_prompt');
        const conversationId = await getConversationId();
        const queued = await sendPrompt({ taskName, prompt, runId, conversationId });
        const task = queued?.taskId ? `Task ${queued.taskId} queued` : 'Prompt queued';
        const run = queued?.runId ? ` for run ${queued.runId}` : '';
        const queue = queued?.queueId ? ` with queueId ${queued.queueId}` : '';
        const position = Number.isInteger(queued?.position) ? ` (queue position ${queued.position})` : '';
        return result(`${task}${run}${queue}${position}. Pi completion is not awaited.`);
      },
    },
    {
      name: 'pi_report_task', label: 'Report delegated task result',
      description: 'After reading and reviewing Pi’s terminal result against the user’s request, persist the task as completed or blocked with a concise, evidence-based summary. The server only allows final reporting after review.',
      parameters: reportParameters,
      async execute(_id, rawArgs) {
        const { taskId, status, summary } = validate(reportParameters, rawArgs, 'pi_report_task');
        const task = await reportTask({ taskId, status, summary, conversationId: await getConversationId() });
        return result(task == null ? 'Task not found.' : JSON.stringify(task));
      },
    },
    {
      name: 'pi_stop_run', label: 'Stop Pi run',
      description: 'Stop a Pi run and discard its queued prompts only when the current user explicitly asks to stop that exact run by name or ID. The server verifies the actual current-user turn. Never use this for a wait timeout or an unknown outcome.',
      parameters: stopParameters,
      async execute(_id, rawArgs) {
        const { runId } = validate(stopParameters, rawArgs, 'pi_stop_run');
        const authorization = await getStopAuthorizationContext();
        const status = await stopRun({ runId, ...authorization });
        return result(status == null ? 'Run not found.' : JSON.stringify(status));
      },
    },
  ];
}
