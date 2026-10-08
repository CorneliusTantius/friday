import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const COMMAND_TIMEOUT_MS = 30_000;
const PROMPT_RESULT_TTL_MS = 10 * 60_000;
const MAX_PROMPT_RESULTS = 500;

function textFromMessage(message) {
  if (typeof message?.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message?.content)) {
    return '';
  }

  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('');
}

function clientMessage(message) {
  const parts = Array.isArray(message.content) ? message.content : [];
  const toolCalls = parts
    .filter((part) => part?.type === 'toolCall')
    .map((part) => ({
      id: part.id,
      name: part.name,
      arguments: part.arguments ?? {},
    }));

  return {
    role: message.role === 'toolResult' ? 'tool' : message.role === 'compactionSummary' ? 'compaction' : message.role,
    content: message.role === 'compactionSummary' && typeof message.summary === 'string' ? message.summary.trim() : textFromMessage(message).trim(),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.isError !== undefined ? { isError: message.isError } : {}),
  };
}

export class PiSession extends EventEmitter {
  constructor({ cwd, command = 'pi', args = [] } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.command = command;
    this.args = args;
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.requestId = 0;
    this.pending = new Map();
    this.activeTurn = null;
    this.operation = null;
    this.operationVersion = 0;
    this.startPromise = null;
    this.sessionPath = null;
    this.model = null;
    this.thinkingLevel = 'off';
    this.promptQueue = [];
    this.promptJobs = new Map();
    this.processingPromptQueue = false;
  }

  get isRunning() {
    return this.child !== null && this.child.exitCode === null;
  }

  get isBusy() {
    return this.operation === 'chat';
  }

  get canAbort() {
    return this.operation === 'chat';
  }

  get hasActiveWork() {
    return Boolean(
      this.operation
      || this.startPromise
      || this.pending.size
      || this.promptQueue.length
      || this.processingPromptQueue
    );
  }

  get workspace() {
    return this.cwd;
  }

  get currentSessionPath() {
    return this.sessionPath;
  }

  get currentModel() {
    return this.model;
  }

  get currentThinkingLevel() {
    return this.thinkingLevel;
  }

  async start() {
    if (this.isRunning) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.#startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess() {
    this.stderr = '';
    this.buffer = '';
    const args = ['--mode', 'rpc', ...this.args];
    if (this.sessionPath) {
      args.push('--session', this.sessionPath);
    }

    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#readStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    let launchError;
    child.once('error', (error) => { launchError = error; this.#fail(error); });
    child.once('exit', (code, signal) => {
      if (this.child !== child) {
        return;
      }

      this.child = null;
      const detail = `Pi exited (code=${code}, signal=${signal || 'none'})${this.stderr ? `: ${this.stderr.trim()}` : ''}`;
      this.#fail(new Error(detail));
      this.emit('exit', { code, signal });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (launchError) throw launchError;
    if (child.exitCode !== null) {
      throw new Error(`Could not start pi${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
    }

    const state = await this.#send({ type: 'get_state' });
    this.#applyState(state.data);
  }

  async getState() {
    const version = this.operationVersion;
    this.#assertReadable();
    await this.start();
    this.#assertReadVersion(version);
    const response = await this.#send({ type: 'get_state' });
    this.#assertReadVersion(version);
    this.#applyState(response.data);
    return response.data;
  }

  async getContextUsage() {
    const version = this.operationVersion;
    this.#assertReadable(true);
    await this.start();
    this.#assertReadVersion(version);
    const response = await this.#send({ type: 'get_session_stats' });
    this.#assertReadVersion(version);
    return response.data.contextUsage || null;
  }

  async availableModels() {
    const version = this.operationVersion;
    this.#assertReadable(true);
    await this.start();
    this.#assertReadVersion(version);
    const response = await this.#send({ type: 'get_available_models' });
    this.#assertReadVersion(version);
    return response.data.models;
  }

  async availableThinkingLevels() {
    const version = this.operationVersion;
    this.#assertReadable(true);
    await this.start();
    this.#assertReadVersion(version);
    const response = await this.#send({ type: 'get_available_thinking_levels' });
    this.#assertReadVersion(version);
    return response.data.levels;
  }

  async setThinkingLevel(level) {
    return this.#runOperation('thinking level change', async () => {
      await this.start();
      await this.#send({ type: 'set_thinking_level', level });
      this.thinkingLevel = level;
    });
  }

  async setSessionName(name) {
    if (this.isBusy) {
      await this.#send({ type: 'set_session_name', name });
      return;
    }

    return this.#runOperation('session rename', async () => {
      await this.start();
      await this.#send({ type: 'set_session_name', name });
    });
  }

  async setModel(provider, modelId) {
    return this.#runOperation('model change', async () => {
      await this.start();
      await this.#send({ type: 'set_model', provider, modelId });
      const state = await this.#send({ type: 'get_state' });
      this.#applyState(state.data);
      return state.data.model;
    });
  }

  async abort() {
    if (!this.isBusy) return false;
    await this.start();
    if (!this.isBusy) return false;
    await this.#send({ type: 'abort' });
    return true;
  }

  enqueuePrompt(message, id = randomUUID()) {
    if (typeof message !== 'string' || !message.trim() || message.length > 20_000) throw new TypeError('prompt must be between 1 and 20000 characters');
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError('invalid queue ID');
    const item = { id, message: message.trim() };
    this.#prunePromptJobs();
    this.promptJobs.set(item.id, { result: null, waiters: new Set(), completedAt: null });
    this.promptQueue.push(item);
    const position = this.promptQueue.length + (this.processingPromptQueue ? 1 : 0);
    this.#emitQueueStatus();
    void this.#processPromptQueue();
    return { queued: true, id: item.id, position };
  }

  waitForPrompt(id, { timeoutMs = 60_000, signal } = {}) {
    this.#prunePromptJobs();
    const job = this.promptJobs.get(id);
    if (!job) return Promise.resolve({ queueId: id, status: 'not_found' });
    if (job.result) {
      const { id: _id, ...outcome } = job.result;
      return Promise.resolve({ queueId: id, ...outcome });
    }
    if (signal?.aborted) return Promise.resolve({ queueId: id, status: 'cancelled' });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        job.waiters.delete(onResult);
        resolve(result);
      };
      const onResult = (result) => finish(result);
      const onAbort = () => finish({ queueId: id, status: 'cancelled' });
      const timer = setTimeout(() => finish({ queueId: id, status: 'timed_out' }), timeoutMs);
      timer.unref?.();
      job.waiters.add(onResult);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  #prunePromptJobs() {
    const now = Date.now();
    for (const [id, job] of this.promptJobs) {
      if (job.completedAt && now - job.completedAt > PROMPT_RESULT_TTL_MS) this.promptJobs.delete(id);
    }
    while (this.promptJobs.size >= MAX_PROMPT_RESULTS) {
      const oldest = this.promptJobs.keys().next().value;
      if (!oldest) break;
      const job = this.promptJobs.get(oldest);
      if (job?.result) this.promptJobs.delete(oldest);
      else break;
    }
  }

  #completePrompt(item, outcome) {
    const result = { id: item.id, ...outcome };
    const job = this.promptJobs.get(item.id);
    if (job) {
      job.result = result;
      job.completedAt = Date.now();
      const { id: _id, ...waitResult } = result;
      for (const waiter of job.waiters) waiter({ queueId: item.id, ...waitResult });
      job.waiters.clear();
    }
    this.emit('prompt_queue_result', result);
  }

  clearPromptQueue() {
    const cleared = this.promptQueue.splice(0);
    for (const item of cleared) this.#completePrompt(item, { status: 'cancelled', error: 'Prompt queue cleared', cancelled: true });
    this.#emitQueueStatus();
    return cleared.length;
  }

  async #processPromptQueue() {
    if (this.processingPromptQueue) return;
    this.processingPromptQueue = true;
    try {
      while (this.promptQueue.length) {
        if (this.operation) {
          await new Promise((resolve) => this.once('status', resolve));
          continue;
        }
        const item = this.promptQueue.shift();
        this.#emitQueueStatus();
        this.emit('prompt_queue_started', { id: item.id });
        try {
          const result = await this.chat(item.message);
          this.#completePrompt(item, { status: 'completed', result });
        } catch (error) {
          this.#completePrompt(item, { status: 'failed', error: error.message });
        }
      }
    } finally {
      this.processingPromptQueue = false;
      this.#emitQueueStatus();
    }
  }

  #emitQueueStatus() {
    const status = { queued: this.promptQueue.length, processing: this.processingPromptQueue };
    this.emit('prompt_queue_status', status);
  }

  async chat(message) {
    return this.#runOperation('chat', async () => {
      await this.start();

      let responseText = '';
      let resolveTurn;
      let rejectTurn;
      const settled = new Promise((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });

      this.activeTurn = {
        append: (event) => {
          if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
            responseText += event.assistantMessageEvent.delta;
          }

          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const finalText = textFromMessage(event.message);
            if (finalText) {
              responseText = finalText;
            }
          }

          if (event.type === 'agent_settled') {
            resolveTurn(responseText);
          }
        },
        reject: rejectTurn,
      };

      try {
        await this.#send({ type: 'prompt', message });
        return await settled;
      } finally {
        this.activeTurn = null;
      }
    });
  }

  async history(limit = null) {
    const version = this.operationVersion;
    this.#assertReadable(true);
    await this.start();
    this.#assertReadVersion(version);
    const response = await this.#send({ type: 'get_messages' });
    this.#assertReadVersion(version);
    const messages = response.data.messages
      .filter((message) => ['user', 'assistant', 'toolResult', 'compactionSummary'].includes(message.role))
      .map(clientMessage)
      .filter((message) => message.content || message.toolCalls?.length);
    return Number.isInteger(limit) && limit > 0 ? messages.slice(-limit) : messages;
  }

  async persistCurrentSession() {
    return this.#runOperation('session persistence', async () => {
      await this.start();
      return this.#persistCurrentSessionFile();
    });
  }

  async #persistCurrentSessionFile() {
    const sessionPath = this.sessionPath;
    if (!sessionPath) throw new Error('Pi did not report a session file');
    await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });

    let info;
    try { info = await lstat(sessionPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error('Pi session path is not a regular file');
    if (info?.size > 0) return sessionPath;
    if (!info) await writeFile(sessionPath, '', { flag: 'wx', mode: 0o600 });

    try {
      const switched = await this.#send({ type: 'switch_session', sessionPath });
      if (switched.data?.cancelled) throw new Error('Pi cancelled saving the new session');
      const state = await this.#send({ type: 'get_state' });
      this.#applyState(state.data);
      return this.sessionPath;
    } catch (error) {
      try {
        const current = await lstat(sessionPath);
        if (current.isFile() && current.size === 0) await unlink(sessionPath);
      } catch {}
      throw error;
    }
  }

  async reset(cwd = this.cwd) {
    return this.#runOperation('session reset', async () => {
      if (cwd !== this.cwd) {
        await this.stop();
        this.cwd = cwd;
        this.sessionPath = null;
        this.model = null;
        this.thinkingLevel = 'off';
        await this.start();
        await this.#persistCurrentSessionFile();
        return;
      }

      await this.start();
      await this.#send({ type: 'new_session' });
      const state = await this.#send({ type: 'get_state' });
      this.#applyState(state.data);
      await this.#persistCurrentSessionFile();
    });
  }

  async switchSession(sessionPath, cwd) {
    return this.#runOperation('session switch', async () => {
      await this.stop();
      this.cwd = cwd;
      this.sessionPath = sessionPath;
      await this.start();
    });
  }

  async stop() {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // A failed start has no process left to stop.
      }
    }

    const child = this.child;
    if (!child) {
      return;
    }

    this.#fail(new Error('Pi session stopped'));
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        resolve();
      }, 1_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }

  #assertReadable(allowDuringChat = false) {
    if (this.operation && !(allowDuringChat && this.operation === 'chat')) {
      const error = new Error(`Cannot read state while ${this.operation} is in progress`);
      error.status = 409;
      throw error;
    }
  }

  #assertReadVersion(version) {
    if (version !== this.operationVersion) {
      const error = new Error('Runtime changed while state was being read');
      error.status = 409;
      throw error;
    }
  }

  async #runOperation(name, operation) {
    if (this.operation) {
      const error = new Error(`Cannot start ${name} while ${this.operation} is in progress`);
      error.status = 409;
      throw error;
    }

    this.operation = name;
    this.operationVersion += 1;
    this.emit('status', {
      operation: name,
      busy: this.isBusy,
      workspace: this.workspace,
      sessionPath: this.currentSessionPath,
    });
    try {
      return await operation();
    } finally {
      this.operation = null;
      this.emit('status', {
        operation: name,
        busy: this.isBusy,
        workspace: this.workspace,
        sessionPath: this.currentSessionPath,
      });
      if (this.promptQueue.length) void this.#processPromptQueue();
    }
  }

  #applyState(state) {
    this.sessionPath = state.sessionFile || this.sessionPath;
    this.model = state.model || this.model;
    this.thinkingLevel = state.thinkingLevel || this.thinkingLevel;
  }

  #readStdout(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        this.#handleMessage(JSON.parse(line));
      } catch (error) {
        this.emit('rpc_error', new Error(`Invalid pi RPC output: ${error.message}`));
      }
    }
  }

  #handleMessage(message) {
    if (message.type === 'response' && message.id && this.pending.has(message.id)) {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.success) {
        request.resolve(message);
      } else {
        request.reject(new Error(message.error || 'Pi RPC request failed'));
      }
      return;
    }

    this.activeTurn?.append(message);
    this.emit('event', message);
  }

  #send(command) {
    if (!this.isRunning || !this.child.stdin?.writable) {
      return Promise.reject(new Error('Pi session is not running'));
    }

    const id = `friday-${++this.requestId}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC timeout for ${command.type}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  #fail(error) {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
    this.activeTurn?.reject(error);
  }
}
