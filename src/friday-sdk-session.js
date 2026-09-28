import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fridaySystemPrompt } from './friday-system-prompt.js';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
}

export function fridayHistory(messages) {
  return messages
    .filter((message) => ['user', 'assistant', 'toolResult'].includes(message.role))
    .map((message) => {
      const content = textFromContent(message.content).trim();
      const toolCalls = Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === 'toolCall').map(({ id, name, arguments: args }) => ({ id, name, arguments: args ?? {} }))
        : [];
      return {
        role: message.role === 'toolResult' ? 'tool' : message.role,
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.isError !== undefined ? { isError: message.isError } : {}),
      };
    })
    .filter((message) => message.content || message.toolCalls?.length);
}

/** Friday-owned SDK-backed PiSession-compatible runtime. */
export class FridaySdkSession extends EventEmitter {
  constructor({ cwd, agentDir, dataDir, sessionManager, createSession = createAgentSession, createModelRuntime = ModelRuntime.create, model, thinkingLevel = 'off' } = {}) {
    super();
    const root = resolve(process.env.FRIDAY_HOME || join(homedir(), '.friday'));
    this.cwd = cwd || join(root, 'data');
    this.agentDir = agentDir || join(root, 'config');
    this.dataDir = dataDir || join(root, 'data');
    this.sessionManager = sessionManager;
    this.createSession = createSession;
    this.createModelRuntime = createModelRuntime;
    this.model = model;
    this.thinkingLevel = thinkingLevel;
    this.session = null;
    this.operation = null;
    this.sessionPath = null;
    this.initializing = null;
    this.unsubscribe = null;
    this.activePrompt = null;
    this.promptStarted = null;
  }

  async start() {
    if (this.session) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        const manager = this.sessionManager || SessionManager.continueRecent(this.cwd, this.dataDir);
        const settingsManager = SettingsManager.create(this.cwd, this.agentDir);
        const modelRuntime = await this.createModelRuntime({
          authPath: join(this.agentDir, 'auth.json'),
          modelsPath: join(this.agentDir, 'models.json'),
        });
        return this.createSession({
          cwd: this.cwd, agentDir: this.agentDir, tools: ['bash', 'edit', 'read', 'write'], modelRuntime, settingsManager,
          resourceLoader: new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager,
            systemPrompt: fridaySystemPrompt,
            noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }),
          sessionManager: manager, model: this.model, thinkingLevel: this.thinkingLevel,
        });
      })()
        .then(({ session }) => {
          this.session = session;
          this.#applyState();
          this.unsubscribe = session.subscribe?.((event) => this.emit('event', event));
        })
        .finally(() => { this.initializing = null; });
    }
    return this.initializing;
  }

  get isRunning() { return this.session !== null; }
  get isBusy() { return Boolean(this.operation); }
  get canAbort() { return this.operation === 'chat'; }
  get currentSessionPath() { return this.session?.sessionFile || this.sessionPath; }
  get currentModel() { return this.session?.model || this.model || null; }
  get currentThinkingLevel() { return this.session?.thinkingLevel || this.thinkingLevel; }

  async #operate(name, callback) {
    if (this.operation) {
      const error = new Error(`Cannot start ${name} while ${this.operation} is in progress`);
      error.status = 409;
      throw error;
    }
    this.operation = name;
    this.emit('status', { operation: name, busy: this.isBusy, sessionPath: this.currentSessionPath });
    try { return await callback(); }
    finally { this.operation = null; this.emit('status', { operation: name, busy: false, sessionPath: this.currentSessionPath }); }
  }

  #applyState() {
    if (!this.session) return;
    this.sessionPath = this.session.sessionFile || this.sessionPath;
    this.model = this.session.model || this.model;
    this.thinkingLevel = this.session.thinkingLevel || this.thinkingLevel;
  }

  async abort() {
    if (!this.canAbort) return false;
    if (!this.activePrompt && this.promptStarted) await this.promptStarted;
    if (!this.canAbort || !this.session) return false;
    await this.session.abort();
    return true;
  }

  async chat(message) {
    return this.#operate('chat', async () => {
      let signalPromptStarted;
      this.promptStarted = new Promise((resolve) => { signalPromptStarted = resolve; });
      try {
        await this.start();
        this.activePrompt = this.session.prompt(message);
        signalPromptStarted();
        await this.activePrompt;
        this.#applyState();
        const assistants = this.session.messages.filter((item) => item.role === 'assistant');
        return textFromContent(assistants.at(-1)?.content).trim();
      } finally {
        signalPromptStarted();
        this.activePrompt = null;
        this.promptStarted = null;
      }
    });
  }

  onEvent(listener) { this.on('event', listener); return () => this.off('event', listener); }
  async availableModels() { await this.start(); return this.session.modelRuntime.getAvailableSnapshot(); }
  async availableThinkingLevels() { await this.start(); return this.session.getAvailableThinkingLevels(); }

  async setModel(provider, id) {
    await this.start();
    const model = typeof provider === 'object' ? provider : this.session.modelRuntime.getAvailableSnapshot().find((item) => item.provider === provider && item.id === id);
    if (!model) throw new Error(`Model not found: ${provider}/${id}`);
    await this.session.setModel(model);
    this.#applyState();
    return this.currentModel;
  }

  async setThinkingLevel(level) {
    await this.start();
    const result = await this.session.setThinkingLevel(level);
    this.#applyState();
    return result;
  }

  async history(limit = null) {
    await this.start();
    const messages = fridayHistory(this.session.messages);
    return Number.isInteger(limit) && limit > 0 ? messages.slice(-limit) : messages;
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.#applyState();
    this.session?.dispose();
    this.session = null;
  }
}
