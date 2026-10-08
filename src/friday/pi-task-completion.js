export function createPiTaskCompletionHandler({ registry, reviewQueue, audit = () => {}, onError = () => {} } = {}) {
  if (!registry || !reviewQueue) throw new TypeError('registry and reviewQueue are required');

  async function enqueue(task, event) {
    const result = reviewQueue.enqueue(task, event);
    if (result === 'full') {
      const queuedAt = new Date().toISOString();
      await registry.updateTask(task.id, {
        status: 'blocked',
        detail: 'Friday review queue is full; the terminal Pi result remains unverified and needs manual review.',
        review: { ...task.review, stage: 'queue-full', queuedAt, finishedAt: queuedAt, errorCode: 'review_queue_full' },
      });
      audit('review_queue_full', { taskId: task.id, runId: task.runId, queueId: task.queueId, stage: 'queue-full', errorCode: 'review_queue_full' });
    } else if (result === 'queued') {
      audit('review_queued', { taskId: task.id, runId: task.runId, queueId: task.queueId, stage: 'queued', queuedAt: task.review?.queuedAt || null });
    } else {
      audit('review_duplicate', { taskId: task.id, runId: task.runId, queueId: task.queueId, stage: task.review?.stage || 'unknown' });
    }
    return result;
  }

  async function handle(queueId, event) {
    try {
      const task = await registry.getTaskForQueue(queueId);
      if (!task) {
        audit('completion_unmatched', { queueId, terminalStatus: 'unknown' });
        return;
      }
      const terminalStatus = ['completed', 'failed', 'cancelled'].includes(event.status) ? event.status : 'unknown';
      audit('completion_received', { taskId: task.id, runId: task.runId, queueId: task.queueId, terminalStatus });
      if (['completed', 'blocked', 'outcome-unknown'].includes(task.status)) {
        audit('completion_ignored_terminal_task', { taskId: task.id, runId: task.runId, queueId: task.queueId, status: task.status });
        return;
      }
      if (event.type === 'started') {
        if (task.status === 'queued') {
          await registry.updateTask(task.id, { status: 'running' });
          audit('pi_work_started', { taskId: task.id, runId: task.runId, queueId: task.queueId, status: 'running' });
        }
        return;
      }
      if (event.status === 'completed') {
        if (task.status === 'reviewing' && reviewQueue.has?.(task)) {
          audit('completion_duplicate', { taskId: task.id, runId: task.runId, queueId: task.queueId, stage: task.review?.stage || 'unknown' });
          return;
        }
        const updated = await registry.updateTask(task.id, {
          status: 'reviewing',
          detail: 'Friday review queued; waiting for a reviewer to become available.',
          review: { ...task.review, stage: 'queued', queuedAt: new Date().toISOString(), errorCode: null },
        });
        if (updated?.status === 'reviewing') await enqueue(updated, event);
        return;
      }
      if (event.status === 'failed' || event.status === 'cancelled') {
        const detail = event.status === 'cancelled' ? 'Pi work was stopped or removed from its queue.' : 'Pi reported a task failure.';
        const updated = await registry.updateTask(task.id, {
          status: 'blocked', detail,
          review: { ...task.review, stage: 'queued', queuedAt: new Date().toISOString(), errorCode: null },
        });
        if (updated?.status === 'blocked') await enqueue(updated, event);
        return;
      }
      await registry.updateTask(task.id, {
        status: 'outcome-unknown',
        detail: 'Pi returned an unrecognized terminal task state; Friday did not retry it.',
      });
      audit('task_outcome_unknown', { taskId: task.id, runId: task.runId, queueId: task.queueId, status: 'outcome-unknown' });
    } catch (error) {
      onError(error);
      audit('task_lifecycle_error', { queueId, errorCode: 'registry_error' });
    }
  }

  return { handle, enqueue };
}
