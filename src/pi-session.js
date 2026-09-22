import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const COMMAND_TIMEOUT_MS = 30_000;

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
    role: message.role === 'toolResult' ? 'tool' : message.role,
    content: textFromMessage(message).trim(),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.isError !== undefined ? { isError: message.isError } : {}),
  };
}

export class PiSession extends EventEmitter {
  constructor({ cwd, command = 'pi' } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.command = command;
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.requestId = 0;
    this.pending = new Map();
    this.activeTurn = null;
    this.sessionPath = null;
    this.model = null;
    this.thinkingLevel = 'off';
  }

  get isRunning() {
    return this.child !== null && this.child.exitCode === null;
  }

  get isBusy() {
    return this.activeTurn !== null;
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

    this.stderr = '';
    this.buffer = '';
    const args = ['--mode', 'rpc'];
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
    child.once('error', (error) => this.#fail(error));
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
    if (child.exitCode !== null) {
      throw new Error(`Could not start pi${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
    }

    const state = await this.#send({ type: 'get_state' });
    this.#applyState(state.data);
  }

  async getState() {
    await this.start();
    const response = await this.#send({ type: 'get_state' });
    this.#applyState(response.data);
    return response.data;
  }

  async availableModels() {
    await this.start();
    const response = await this.#send({ type: 'get_available_models' });
    return response.data.models;
  }

  async availableThinkingLevels() {
    await this.start();
    const response = await this.#send({ type: 'get_available_thinking_levels' });
    return response.data.levels;
  }

  async setThinkingLevel(level) {
    if (this.activeTurn) {
      throw new Error('Cannot change thinking level while the agent is responding');
    }
    await this.start();
    await this.#send({ type: 'set_thinking_level', level });
    this.thinkingLevel = level;
  }

  async setModel(provider, modelId) {
    if (this.activeTurn) {
      throw new Error('Cannot change models while the agent is responding');
    }
    await this.start();
    await this.#send({ type: 'set_model', provider, modelId });
    const state = await this.#send({ type: 'get_state' });
    this.#applyState(state.data);
    return state.data.model;
  }

  async chat(message) {
    await this.start();

    if (this.activeTurn) {
      throw new Error('The agent is already responding');
    }

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
  }

  async history() {
    await this.start();
    const response = await this.#send({ type: 'get_messages' });
    return response.data.messages
      .filter((message) => ['user', 'assistant', 'toolResult'].includes(message.role))
      .map(clientMessage)
      .filter((message) => message.content || message.toolCalls?.length);
  }

  async reset(cwd = this.cwd) {
    if (this.activeTurn) {
      throw new Error('Cannot reset while the agent is responding');
    }

    if (cwd !== this.cwd) {
      await this.stop();
      this.cwd = cwd;
      this.sessionPath = null;
      this.model = null;
      this.thinkingLevel = 'off';
      return;
    }

    await this.start();
    await this.#send({ type: 'new_session' });
    const state = await this.#send({ type: 'get_state' });
    this.#applyState(state.data);
  }

  async switchSession(sessionPath, cwd) {
    if (this.activeTurn) {
      throw new Error('Cannot switch sessions while the agent is responding');
    }

    await this.stop();
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    await this.start();
  }

  async stop() {
    const child = this.child;
    if (!child) {
      return;
    }

    this.#fail(new Error('Pi session stopped'));
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
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
