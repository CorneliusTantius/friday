export function createPiTaskCompletionHandler({ registry, reviewQueue, onError = (error) => console.error(`Pi task completion handling failed: ${error.message}`) } = {}) {
  if (!registry || !reviewQueue) throw new TypeError('registry and reviewQueue are required');

  function enqueue(task, event) {
    const result = reviewQueue.enqueue(task, event);
    if (result === 'full') {
      void registry.updateTask(task.id, {
        status: 'blocked',
        detail: 'Friday review queue is full; the terminal Pi result remains unverified and needs manual review.',
      });
    }
    return result;
  }

  async function handle(queueId, event) {
    try {
      const task = await registry.getTaskForQueue(queueId);
      if (!task || ['completed', 'blocked', 'outcome-unknown'].includes(task.status)) return;
      if (event.type === 'started') {
        if (task.status === 'queued') await registry.updateTask(task.id, { status: 'running' });
        return;
      }
      if (event.status === 'completed') {
        const updated = await registry.updateTask(task.id, {
          status: 'reviewing',
          detail: 'Pi finished; Friday is checking the result against the original request.',
        });
        if (updated?.status === 'reviewing') enqueue(updated, event);
        return;
      }
      if (event.status === 'failed' || event.status === 'cancelled') {
        const detail = event.status === 'cancelled' ? 'Pi work was stopped or removed from its queue.' : 'Pi reported a task failure.';
        const updated = await registry.updateTask(task.id, { status: 'blocked', detail });
        if (updated?.status === 'blocked') enqueue(updated, event);
        return;
      }
      await registry.updateTask(task.id, {
        status: 'outcome-unknown',
        detail: 'Pi returned an unrecognized terminal task state; Friday did not retry it.',
      });
    } catch (error) {
      onError(error);
    }
  }

  return { handle, enqueue };
}
