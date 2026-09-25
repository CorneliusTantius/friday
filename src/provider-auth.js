import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_ERROR = 'Provider authentication failed';

/** Server-side provider auth, isolated to an explicit agent directory. */
export class ProviderAuth {
  constructor({ agentDir, createModelRuntime = ModelRuntime.create, challengeTtlMs = 5 * 60_000 } = {}) {
    if (!agentDir) throw new TypeError('agentDir is required');
    this.agentDir = resolve(agentDir);
    this.createModelRuntime = createModelRuntime;
    this.challengeTtlMs = challengeTtlMs;
    this.runtimePromise = null;
    this.challenges = new Map();
  }

  async runtime() {
    if (!this.runtimePromise) this.runtimePromise = (async () => {
      await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
      return this.createModelRuntime({ authPath: join(this.agentDir, 'auth.json'), modelsPath: join(this.agentDir, 'models.json') });
    })().catch((error) => { this.runtimePromise = null; throw error; });
    return this.runtimePromise;
  }

  async status(providerId) {
    const runtime = await this.runtime();
    const status = runtime.getProviderAuthStatus(providerId);
    return { providerId, configured: Boolean(runtime.hasConfiguredAuth(providerId)), status: typeof status === 'string' ? status : status?.status ?? 'unknown' };
  }

  async loginApiKey(providerId, apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('apiKey is required');
    try { await (await this.runtime()).login(providerId, 'api_key', { prompt: async () => apiKey, notify: () => {} }); return await this.status(providerId); }
    catch { throw new Error(SAFE_ERROR); }
  }

  async beginOAuth(providerId, { ttlMs = this.challengeTtlMs } = {}) {
    const runtime = await this.runtime();
    const id = randomUUID();
    const challenge = { id, providerId, steps: [], wake: null, pendingAnswer: null, controller: new AbortController(), timer: setTimeout(() => this.cancel(id), ttlMs) };
    challenge.timer.unref?.();
    this.challenges.set(id, challenge);
    const notify = (event) => this.publish(id, typeof event === 'string' ? { type: 'info', message: event } : event);
    const prompt = (value) => new Promise((resolve, reject) => {
      if (value?.signal?.aborted) { reject(value.signal.reason || new Error('Prompt cancelled')); return; }
      const onAbort = () => { challenge.pendingAnswer = null; reject(new Error('Prompt cancelled')); };
      value?.signal?.addEventListener('abort', onAbort, { once: true });
      challenge.pendingAnswer = (answer) => { value?.signal?.removeEventListener('abort', onAbort); resolve(answer); };
      this.publish(id, { type: 'prompt', ...(typeof value === 'string' ? { message: value } : value), requiresResponse: true });
    });
    challenge.login = Promise.resolve().then(() => runtime.login(providerId, 'oauth', { prompt, notify, signal: challenge.controller.signal }))
      .then(() => this.finish(id, { ok: true }), () => this.finish(id, { ok: false, error: SAFE_ERROR }));
    return { id };
  }

  publish(id, step) {
    const challenge = this.challenges.get(id);
    if (!challenge) return;
    // SDK callbacks may include secrets; only expose recognized interaction fields.
    const safe = { type: step.type, ...(step.requiresResponse === true ? { requiresResponse: true } : {}) };
    for (const key of ['url', 'verificationUri', 'verification_uri', 'userCode', 'user_code', 'instructions', 'message', 'prompt', 'placeholder', 'inputType', 'options', 'label', 'links']) {
      if (typeof step[key] === 'string' || Array.isArray(step[key])) safe[key] = step[key];
    }
    challenge.steps.push(safe);
    challenge.wake?.();
    challenge.wake = null;
  }

  async next(id, { signal } = {}) {
    const challenge = this.challenges.get(id);
    if (!challenge) return { ok: false, error: 'Challenge unavailable' };
    if (signal?.aborted) { this.cancel(id); return { ok: false, error: 'Cancelled' }; }
    const step = challenge.steps.shift();
    if (!step && challenge.result) { this.remove(id); return challenge.result; }
    if (step) return { ok: true, step };
    return new Promise((resolve) => {
      const timer = setTimeout(() => { challenge.wake = null; resolve({ ok: false, error: 'Pending' }); }, 1000);
      challenge.wake = () => { clearTimeout(timer); const next = challenge.steps.shift(); if (next) resolve({ ok: true, step: next }); else if (challenge.result) { this.remove(id); resolve(challenge.result); } else resolve({ ok: false, error: 'Challenge unavailable' }); };
      signal?.addEventListener('abort', () => { clearTimeout(timer); this.cancel(id); resolve({ ok: false, error: 'Cancelled' }); }, { once: true });
    });
  }

  cancel(id) {
    const challenge = this.challenges.get(id);
    if (!challenge) return false;
    this.remove(id);
    challenge.controller.abort();
    challenge.pendingAnswer?.('');
    challenge.wake?.();
    return true;
  }

  remove(id) {
    const challenge = this.challenges.get(id);
    if (challenge) clearTimeout(challenge.timer);
    this.challenges.delete(id);
  }

  finish(id, result) {
    const challenge = this.challenges.get(id);
    if (!challenge) return;
    challenge.result = result;
    challenge.wake?.();
  }

  async answer(id, answer) {
    const challenge = this.challenges.get(id);
    if (!challenge) return { ok: false, error: 'Challenge unavailable' };
    if (typeof answer !== 'string' || !challenge.pendingAnswer) return { ok: false, error: 'No answer requested' };
    const resolve = challenge.pendingAnswer;
    challenge.pendingAnswer = null;
    resolve(answer);
    return { ok: true };
  }
}

export function createProviderAuth(options) { return new ProviderAuth(options); }
