export function createPiTaskReviewQueue({ review, onError = (error) => console.error(`Pi task review failed: ${error.message}`), maxQueued = 32, dedupeLimit = 500 } = {}) {
  if (typeof review !== 'function') throw new TypeError('review callback is required');
  if (!Number.isInteger(maxQueued) || maxQueued < 1) throw new TypeError('maxQueued must be a positive integer');
  const jobs = [];
  const pending = new Set();
  const completed = new Set();
  const tails = new Map();
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (jobs.length) {
        const job = jobs.shift();
        await job.previous;
        try {
          await review(job.task, job.event);
        } catch (error) {
          onError(error, job.task, job.event);
        } finally {
          pending.delete(job.key);
          completed.add(job.key);
          while (completed.size > dedupeLimit) completed.delete(completed.values().next().value);
          job.release();
          if (tails.get(job.task.conversationId) === job.tail) tails.delete(job.task.conversationId);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(task, event) {
      const key = `${task.runId}:${task.queueId}`;
      if (pending.has(key) || completed.has(key)) return 'duplicate';
      if (jobs.length >= maxQueued) return 'full';
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const previous = tails.get(task.conversationId) || Promise.resolve();
      const tail = previous.then(() => gate);
      tails.set(task.conversationId, tail);
      pending.add(key);
      jobs.push({ task, event, key, previous, release, tail });
      void drain();
      return 'queued';
    },
    has(task) {
      const key = `${task.runId}:${task.queueId}`;
      return pending.has(key) || completed.has(key);
    },
    async waitFor(conversationId) {
      const tail = tails.get(conversationId);
      if (tail) await tail;
    },
    get pendingCount() { return pending.size; },
  };
}
