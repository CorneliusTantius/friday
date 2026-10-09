import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpus, freemem, homedir, hostname, loadavg, platform, totalmem } from 'node:os';
import { createInterface } from 'node:readline';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PiSession } from './pi/pi-session.js';
import { FridaySdkSession } from './friday/friday-sdk-session.js';
import { createFridayMemory } from './friday/friday-memory.js';
import { createPiRunRegistry, DEFAULT_STAFF_CAPACITY } from './pi/pi-run-registry.js';
import { createPiTaskReviewQueue } from './friday/pi-task-review-queue.js';
import { createPiTaskReviewHandler } from './friday/pi-task-review.js';
import { createPiTaskCompletionHandler } from './friday/pi-task-completion.js';
import { createProviderAuth } from './integrations/provider-auth.js';
import { fridayPaths, loadConfig, migrateStorage } from './config.js';
import { createRepositoryStore } from './storage/repos.js';
import { browseNotes, readNote } from './storage/notes.js';
import { listAgentFiles, readAgentFile, writeAgentFile } from './storage/agent-files.js';
import { millisecondsUntilNextQuarterHour, syncGitHubSnapshot, validateGitHubSyncTarget } from './integrations/github-sync.js';
import { createFinanceStore } from './storage/finances.js';
import { createHostTemperatureMonitor } from './host-temperature.js';
import { createLocalCalendarStore } from './storage/local-calendar.js';
import { assertPiSessionDeletable, assertPiSessionDeleteAuthorized, deletePiSessionWithPolicy } from './pi/pi-session-delete-policy.js';
import { assertPiSessionCreateAuthorized } from './pi/pi-session-create-policy.js';
import { assertPiSessionRenameAuthorized } from './pi/pi-session-rename-policy.js';
import { assertPiSessionProfileAuthorized } from './pi/pi-session-profile-policy.js';
import { assertPiRunStopAuthorized } from './pi/pi-run-stop-policy.js';
import { assertPiRunAcceptsPrompt, resolveSelectedPiRun } from './pi/pi-prompt-routing.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const paths = fridayPaths();
const repositories = createRepositoryStore({ directory: paths.reposDir });
const finances = createFinanceStore({ file: join(paths.dataDir, 'finances.json') });
const hostTemperature = createHostTemperatureMonitor();
const localCalendar = createLocalCalendarStore({ file: join(paths.dataDir, 'calendar', 'events.json') });
let calendarContentAccessed = false;
const calendarControl = { onSensitiveRead: () => { calendarContentAccessed = true; } };
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
const piWorkspaceDir = join(dirname(agentDir), 'workspace');
const fridayAuth = createProviderAuth({ agentDir: paths.configDir });
const piAuth = createProviderAuth({ agentDir });
const syncConfigFile = join(paths.configDir, 'github-sync.json');
const syncStateRoot = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'friday');
const syncStateFile = join(syncStateRoot, 'github-friday.json');
const auditPiTaskLifecycle = (event, details = {}) => console.log(JSON.stringify({
  component: 'pi-task-lifecycle',
  timestamp: new Date().toISOString(),
  event,
  ...details,
}));
const fridayMemory = createFridayMemory({ directory: join(paths.root, 'memory') });
const piRunRegistry = createPiRunRegistry({
  file: join(syncStateRoot, 'pi-runs.json'),
  onRecovery: (recovered) => auditPiTaskLifecycle('task_recovered_after_restart', recovered),
});
const syncState = { friday: { busy: false, error: null, promise: null } };
const workspaceRoots = [resolve(homedir()), paths.workspaceDir, repositories.directory];
let initialWorkspace = paths.workspaceDir;
let preferredWorkspace = initialWorkspace;
const settingsFile = paths.configFile;
const sessionStorage = join(agentDir, 'sessions');
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fridayChatDir = process.env.FRIDAY_CHAT_DIR ? resolve(process.env.FRIDAY_CHAT_DIR) : paths.workspaceDir;
const fridaySessionDir = process.env.FRIDAY_CHAT_DIR ? join(fridayChatDir, 'sessions') : paths.dataDir;
const publicRoot = join(projectRoot, 'public');
const piSessions = new Map();
const piRequestEntries = new WeakMap();
const piRunOpenings = new Map();
const piRunOperations = new Map();
const deletingPiRuns = new Set();
let fridayPi;
let fridayInit;
const runtimeViewers = new Map();
const sessionMutations = new Set();
const execFileAsync = promisify(execFile);
const piCommand = process.env.PI_COMMAND || 'pi';
const piUpdateTimeoutMs = 180_000;
let piUpdateStatus = { state: 'idle', operation: null, message: '', startedAt: null, finishedAt: null };
const maxPiSessions = 32;
const runtimeViewerTtlMs = 60_000;
const runtimeIdleTtlMs = 15 * 60_000;
const runtimeCleanupIntervalMs = 60_000;
const appPassword = process.env.FRIDAY_APP_PASSWORD || '';
if (!appPassword) {
  throw new Error('Set FRIDAY_APP_PASSWORD to a non-empty value before starting Friday');
}
const appPasswordSalt = randomBytes(16);
const appPasswordDigest = scryptSync(appPassword, appPasswordSalt, 32);
const appSessionCookie = '__Host-friday-session';
const appSessions = new Map();
const failedLogins = new Map();
const appSessionIdleTtlMs = 12 * 60 * 60_000;
const loginWindowMs = 15 * 60_000;
const maxLoginFailures = 5;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  return request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || null;
}

function appSessionId(request) {
  return cookieValue(request, appSessionCookie);
}

function isAppAuthenticated(request) {
  const id = appSessionId(request);
  const session = id && appSessions.get(id);
  if (!session) return false;
  if (Date.now() - session.lastSeenAt > appSessionIdleTtlMs) {
    appSessions.delete(id);
    return false;
  }
  session.lastSeenAt = Date.now();
  return true;
}

function passwordMatches(value) {
  if (typeof value !== 'string' || !value) return false;
  const digest = scryptSync(value, appPasswordSalt, 32);
  return timingSafeEqual(digest, appPasswordDigest);
}

function loginRateLimit(request) {
  const address = request.socket.remoteAddress || 'unknown';
  const failures = failedLogins.get(address);
  const now = Date.now();
  if (!failures) return { address, blocked: false };
  if (now - failures.startedAt >= loginWindowMs) {
    failedLogins.delete(address);
    return { address, blocked: false };
  }
  return { address, blocked: failures.count >= maxLoginFailures, retryAfter: Math.ceil((loginWindowMs - (now - failures.startedAt)) / 1000) };
}

function recordFailedLogin(address) {
  const now = Date.now();
  for (const [key, value] of failedLogins) {
    if (now - value.startedAt >= loginWindowMs) failedLogins.delete(key);
  }
  const previous = failedLogins.get(address);
  if (!previous || now - previous.startedAt >= loginWindowMs) failedLogins.set(address, { startedAt: now, count: 1 });
  else previous.count += 1;
}

function appSessionCookieHeader(value, maxAge = null) {
  return `${appSessionCookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict${maxAge === null ? '' : `; Max-Age=${maxAge}`}`;
}

function redirect(response, location) {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function validClientId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function clientIdFor(request) {
  const value = request.headers['x-friday-session'];
  return validClientId(value) ? value : 'default';
}

function viewerIdFor(request) {
  const value = request.headers['x-friday-client'];
  return validClientId(value) ? value : clientIdFor(request);
}

function touchRuntimeViewer(runtimeId, viewerId, now = Date.now()) {
  let viewers = runtimeViewers.get(runtimeId);
  if (!viewers) {
    viewers = new Map();
    runtimeViewers.set(runtimeId, viewers);
  }
  viewers.set(viewerId, now);
}

function pruneRuntimeViewers(now = Date.now()) {
  for (const [runtimeId, viewers] of runtimeViewers) {
    for (const [viewerId, lastSeen] of viewers) {
      if (now - lastSeen > runtimeViewerTtlMs) viewers.delete(viewerId);
    }
    if (!viewers.size) runtimeViewers.delete(runtimeId);
  }
}

function runtimeHasViewers(runtimeId) {
  pruneRuntimeViewers();
  return Boolean(runtimeViewers.get(runtimeId)?.size);
}

function runtimeHasOtherViewers(runtimeId, viewerId) {
  pruneRuntimeViewers();
  const viewers = runtimeViewers.get(runtimeId);
  return [...(viewers?.keys() || [])].some((candidate) => candidate !== viewerId);
}

async function retireRuntime(runtimeId, entry) {
  if (piSessions.get(runtimeId) !== entry) return;
  piSessions.delete(runtimeId);
  runtimeViewers.delete(runtimeId);
  await entry.pi.stop();
}

async function cleanupIdleRuntimes(now = Date.now()) {
  pruneRuntimeViewers(now);
  const stopping = [];
  for (const [runtimeId, entry] of piSessions) {
    if (
      now - entry.lastUsed <= runtimeIdleTtlMs
      || entry.pi.hasActiveWork
      || entry.requests > 0
      || runtimeHasViewers(runtimeId)
    ) continue;

    stopping.push(retireRuntime(runtimeId, entry).catch(() => {}));
  }
  await Promise.all(stopping);
}

const runCompletionReview = createPiTaskReviewHandler({
  registry: piRunRegistry,
  getFridayPi,
  restrictedControl: {
    listConversations: listPiConversations,
    getRunStatus: getPiRunStatus,
    readConversation: readPiConversation,
    reportTask: reportDelegatedTask,
  },
  audit: auditPiTaskLifecycle,
});

const completionReviews = createPiTaskReviewQueue({
  review: runCompletionReview,
  onError: (_error, task) => auditPiTaskLifecycle('review_queue_error', {
    taskId: task?.id, runId: task?.runId, queueId: task?.queueId, errorCode: 'review_queue_error',
  }),
});
const piTaskCompletion = createPiTaskCompletionHandler({
  registry: piRunRegistry,
  reviewQueue: completionReviews,
});
const updatePiTaskFromQueueEvent = piTaskCompletion.handle;

function createPiRuntime(runtimeId, cwd = preferredWorkspace) {
  if (piSessions.size >= maxPiSessions) {
    const idle = [...piSessions.entries()]
      .filter(([runtimeId, candidate]) => (
        !candidate.pi.hasActiveWork
        && candidate.requests === 0
        && !runtimeHasViewers(runtimeId)
      ))
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
    if (!idle) {
      throw new RequestError('Too many active Pi sessions', 429);
    }
    piSessions.delete(idle[0]);
    runtimeViewers.delete(idle[0]);
    void idle[1].pi.stop();
  }

  const pi = new PiSession({ cwd, command: piCommand });
  pi.on('prompt_queue_started', ({ id }) => { void updatePiTaskFromQueueEvent(id, { type: 'started' }); });
  pi.on('prompt_queue_result', (event) => { void updatePiTaskFromQueueEvent(event.id, event); });
  const entry = { pi, lastUsed: Date.now(), requests: 0 };
  piSessions.set(runtimeId, entry);
  return entry.pi;
}

function piForRequest(request) {
  const clientId = clientIdFor(request);
  let entry = piSessions.get(clientId);
  if (!entry) {
    createPiRuntime(clientId);
    entry = piSessions.get(clientId);
  }
  entry.lastUsed = Date.now();
  entry.requests += 1;
  piRequestEntries.set(request, entry);
  touchRuntimeViewer(clientId, viewerIdFor(request), entry.lastUsed);
  return entry.pi;
}

function releasePiRequest(request) {
  const entry = piRequestEntries.get(request);
  if (!entry) return;
  piRequestEntries.delete(request);
  entry.requests = Math.max(0, entry.requests - 1);
}

async function resetFridayAfterAuth() {
  if (!fridayPi) return;
  if (fridayPi.isBusy) throw new RequestError('Friday is busy; retry after the current reply', 409);
  const previous = fridayPi;
  fridayPi = null;
  await previous.stop();
}

const piControl = {
  listConversations: listPiConversations,
  createSession: createPiConversation,
  renameSession: renamePiConversation,
  updateProfile: updatePiStaffProfile,
  sendPrompt: enqueuePiPrompt,
  reportTask: reportDelegatedTask,
  getRunStatus: getPiRunStatus,
  readConversation: readPiConversation,
  deleteSession: deletePiConversation,
  stopRun: stopPiRun,
  waitForPrompt: waitForPiPrompt,
};

async function getFridayPi() {
  if (fridayPi) return fridayPi;
  if (!fridayInit) {
    fridayInit = (async () => {
      await mkdir(fridaySessionDir, { recursive: true, mode: 0o700 });
      const pi = new FridaySdkSession({ cwd: fridayChatDir, dataDir: fridaySessionDir, agentDir: paths.configDir, memory: fridayMemory, piControl, calendarControl });
      try {
        await pi.start();
        fridayPi = pi;
        return pi;
      } catch (error) {
        await pi.stop();
        throw error;
      }
    })().finally(() => { fridayInit = null; });
  }
  return fridayInit;
}

const runtimeCleanupTimer = setInterval(() => {
  void cleanupIdleRuntimes();
}, runtimeCleanupIntervalMs);
runtimeCleanupTimer.unref();

function runningPiSessions(workspace) {
  return [...piSessions.entries()]
    .map(([runtimeId, entry]) => ({
      runtimeId,
      workspace: entry.pi.workspace,
      sessionPath: entry.pi.currentSessionPath,
      running: entry.pi.isRunning,
      busy: entry.pi.isBusy,
      lastUsed: entry.lastUsed,
    }))
    .filter((entry) => entry.workspace === workspace && entry.sessionPath);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function modelForClient(model) {
  if (!model) return null;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
  };
}

async function readJson(request, maxBytes = 64 * 1024) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      throw new RequestError('Request body is too large');
    }
  }

  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new RequestError('Request body must be valid JSON');
  }
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function normalizeWorkspaceInput(value) {
  const input = value.trim();
  return input.startsWith('cd ') ? input.slice(3).trim() : input;
}

async function existingDirectory(path) {
  try {
    const realPath = await realpath(path);
    return (await stat(realPath)).isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

async function allowedRootPaths() {
  const roots = await Promise.all(workspaceRoots.map(existingDirectory));
  return roots.filter(Boolean);
}

async function resolveWorkspace(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new RequestError('cwd is required');
  }

  const candidate = await existingDirectory(normalizeWorkspaceInput(path));
  if (!candidate) {
    throw new RequestError('cwd must be an existing directory');
  }

  const roots = await allowedRootPaths();
  if (!roots.some((root) => isWithin(root, candidate))) {
    throw new RequestError('cwd is outside the configured workspace roots');
  }

  return candidate;
}

async function loadPersistedWorkspace() {
  try {
    const config = await loadConfig();
    const legacyDefaults = [resolve(dirname(agentDir)), resolve(piWorkspaceDir)];
    const migrateDefault = !process.env.FRIDAY_WORKSPACE && legacyDefaults.includes(resolve(config.workspace));
    const workspace = await resolveWorkspace(migrateDefault ? initialWorkspace : config.workspace);
    initialWorkspace = workspace;
    preferredWorkspace = workspace;
    if (migrateDefault) await persistWorkspace(workspace);
  } catch {
    // Missing or stale settings should fall back to the configured default root.
  }
}

async function persistWorkspace(workspace) {
  await mkdir(dirname(settingsFile), { recursive: true });
  let config = {};
  try { config = JSON.parse(await readFile(settingsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(settingsFile, `${JSON.stringify({ ...config, workspace }, null, 2)}\n`, { mode: 0o600 });
  preferredWorkspace = workspace;
}

function normalizeDevice(raw, id, { local = false, self = false } = {}) {
  return {
    id: raw?.ID || id,
    hostname: raw?.HostName || raw?.DNSName || id,
    dnsName: raw?.DNSName || null,
    os: raw?.OS || platform(),
    addresses: Array.isArray(raw?.TailscaleIPs) ? raw.TailscaleIPs : [],
    online: local ? true : raw?.Online === true,
    lastSeen: raw?.LastSeen || null,
    local,
    self,
  };
}

async function listDevices() {
  const usage = await getSystemUsage();
  const localDevice = normalizeDevice({ HostName: hostname(), OS: platform() }, 'local', {
    local: true,
    self: true,
  });
  localDevice.usage = usage;
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5_000,
    });
    const status = JSON.parse(stdout);
    const self = normalizeDevice(status.Self, 'self', { local: true, self: true });
    self.usage = usage;
    const devices = [self];
    for (const [id, peer] of Object.entries(status.Peer || {})) {
      devices.push(normalizeDevice(peer, id));
    }
    return { available: true, devices };
  } catch (error) {
    return {
      available: false,
      error: error.code === 'ENOENT'
        ? 'Tailscale is not installed on the Friday host'
        : 'Tailscale is unavailable or not authenticated',
      devices: [localDevice],
    };
  }
}

async function listInstalledPiPackages(workspace, requirePi = false) {
  try {
    const { stdout } = await execFileAsync(piCommand, ['list'], {
      cwd: workspace,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: 5_000,
    });
    const packages = [];
    let scope = 'user';
    for (const rawLine of stdout.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === 'User packages:') { scope = 'user'; continue; }
      if (line === 'Project packages:') { scope = 'project'; continue; }
      if (/^  \S/.test(rawLine) && !/^    /.test(rawLine)) {
        const filtered = line.endsWith(' (filtered)');
        packages.push({ source: filtered ? line.slice(0, -11) : line, scope, filtered, installedPath: null });
      } else if (/^    \S/.test(rawLine) && packages.length) {
        packages[packages.length - 1].installedPath = line;
      }
    }
    return { packages, error: null };
  } catch (error) {
    if (requirePi && error.code === 'ENOENT') throw new RequestError('Pi is not installed. Install the Pi CLI from https://pi.dev and ensure pi is on PATH, or set PI_COMMAND.', 404);
    return { packages: [], error: 'Installed Pi packages could not be loaded' };
  }
}

async function updatePi(operation, workspace) {
  if (piUpdateStatus.state === 'updating') throw new RequestError('A Pi update is already running', 409);
  if ([...piSessions.values()].some(({ pi }) => pi.isBusy)) {
    throw new RequestError('Pause active Pi tasks before updating Pi or its extensions', 409);
  }

  const args = operation === 'extensions'
    ? ['update', '--extensions', '--no-approve']
    : ['update', '--self', '--no-approve'];
  const startedAt = new Date().toISOString();
  piUpdateStatus = { state: 'updating', operation, message: operation === 'extensions' ? 'Updating installed Pi extensions…' : 'Updating the Pi CLI…', startedAt, finishedAt: null };
  try {
    await execFileAsync(piCommand, args, {
      cwd: workspace,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: piUpdateTimeoutMs,
    });
    piUpdateStatus = {
      state: 'succeeded', operation,
      message: operation === 'extensions' ? 'Pi extension update completed successfully.' : 'Pi CLI update completed successfully.',
      startedAt, finishedAt: new Date().toISOString(),
    };
    return piUpdateStatus;
  } catch (error) {
    const message = error.code === 'ENOENT'
      ? 'Pi CLI could not be found. Check the Friday host PATH or PI_COMMAND setting.'
      : error.killed || error.code === 'ETIMEDOUT'
        ? 'Pi update timed out. Check Pi CLI status on the host before retrying.'
        : 'Pi update failed. Check Pi CLI status on the host before retrying.';
    piUpdateStatus = { state: 'failed', operation, message, startedAt, finishedAt: new Date().toISOString() };
    throw new RequestError(message, error.code === 'ENOENT' ? 404 : 502);
  }
}

async function listWorkspaceSuggestions(prefix = '') {
  const roots = await allowedRootPaths();
  const paths = new Map();
  const add = (path) => paths.set(path, path);
  const addChildren = async (parent, filter = '') => {
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || (filter && !entry.name.toLowerCase().startsWith(filter.toLowerCase()))) {
        continue;
      }
      const child = await existingDirectory(join(parent, entry.name));
      if (child && roots.some((root) => isWithin(root, child))) {
        add(child);
      }
    }
  };

  const input = normalizeWorkspaceInput(prefix);
  if (!input) {
    for (const root of roots) {
      add(root);
      await addChildren(root);
    }
  } else {
    const candidate = resolve(input);
    const direct = await existingDirectory(candidate);
    if (direct && roots.some((root) => isWithin(root, direct))) {
      add(direct);
      await addChildren(direct);
    } else {
      const parent = await existingDirectory(dirname(candidate));
      if (parent && roots.some((root) => isWithin(root, parent))) {
        await addChildren(parent, basename(candidate));
      }
    }
  }

  return [...paths.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ path, label: basename(path) || path }));
}

function sessionDirectoriesFor(cwd) {
  const safePath = resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  const directories = [join(sessionStorage, `--${safePath}--`)];
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    const configured = resolve(process.env.PI_CODING_AGENT_SESSION_DIR);
    if (!directories.includes(configured)) directories.unshift(configured);
  }
  return directories;
}

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

async function readSessionMetadata(path, workspace, legacyWorkspaces = []) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header;
  let name;
  let firstMessage = '';
  let messageCount = 0;
  let modified = null;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === 'session') {
        header = entry;
        modified = entry.timestamp;
      } else if (entry.type === 'session_info') {
        name = entry.name;
      } else if (entry.type === 'message') {
        const message = entry.message;
        if (['user', 'assistant', 'toolResult'].includes(message?.role)) {
          messageCount += 1;
          modified = entry.timestamp || modified;
          if (!firstMessage && message.role === 'user') {
            firstMessage = textFromMessage(message);
          }
        }
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!header || (resolve(header.cwd) !== resolve(workspace) && !legacyWorkspaces.some((path) => resolve(path) === resolve(header.cwd)))) {
    return null;
  }

  const fileStats = await stat(path);
  return {
    id: header.id,
    path,
    cwd: workspace,
    name: name || firstMessage.slice(0, 100) || 'Untitled session',
    preview: firstMessage.slice(0, 160),
    created: header.timestamp,
    modified: fileStats.mtime.toISOString() || modified,
    messageCount,
  };
}

async function listSessions(workspace, legacyWorkspaces = []) {
  const sessions = await Promise.all(sessionDirectoriesFor(workspace).map(async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return []; }
    return Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => readSessionMetadata(join(directory, entry.name), workspace, legacyWorkspaces)));
  }));

  return sessions.flat()
    .filter(Boolean)
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

async function findSession(workspace, path) {
  if (typeof path !== 'string' || !path) {
    throw new RequestError('session path is required');
  }
  const session = (await listSessions(workspace)).find((item) => item.path === path);
  if (!session) throw new RequestError('session was not found in the selected workspace', 404);
  return session;
}

function runtimeForSessionPath(workspace, sessionPath) {
  return [...piSessions.entries()]
    .filter(([, entry]) => entry.pi.workspace === workspace && entry.pi.currentSessionPath === sessionPath)
    .sort(([, a], [, b]) => Number(b.pi.isBusy) - Number(a.pi.isBusy)
      || (b.pi.promptQueue?.length || 0) - (a.pi.promptQueue?.length || 0))
    .map(([runtimeId, entry]) => ({ runtimeId, pi: entry.pi }))[0] || null;
}

async function sessionsWithRunIds(workspace, { includeRepositoryVisibility = false, includeNavigationLabel = false } = {}) {
  const sessions = await listSessions(workspace);
  const runIds = await piRunRegistry.ensureRuns(sessions.map(({ path, id, name }) => ({ workspace, sessionPath: path, sessionId: id, name })));
  const registeredRuns = await Promise.all(runIds.map((runId) => piRunRegistry.getRun(runId)));
  return Promise.all(sessions.map(async (session, index) => {
    const runId = runIds[index];
    const runtime = runtimeForSessionPath(workspace, session.path);
    const run = registeredRuns[index];
    const tasks = await piRunRegistry.listTasks({ runId });
    const openTasks = tasks.filter((task) => ['queued', 'running', 'reviewing', 'outcome-unknown'].includes(task.status));
    const workload = {
      queued: openTasks.filter((task) => task.status === 'queued').length,
      running: openTasks.filter((task) => task.status === 'running').length,
      reviewing: openTasks.filter((task) => task.status === 'reviewing').length,
      unknown: openTasks.filter((task) => task.status === 'outcome-unknown').length,
      openTasks: openTasks.length,
    };
    return {
      ...session,
      runId,
      domain: run?.domain || null,
      purpose: run?.purpose || null,
      ...(includeNavigationLabel ? { navigationLabel: run?.navigationLabel || null } : {}),
      expertise: run?.expertise || [],
      responsibilities: run?.responsibilities || [],
      ...(includeRepositoryVisibility ? { hiddenRepositories: run?.hiddenRepositories || [] } : {}),
      capacity: Number.isInteger(run?.capacity) ? run.capacity : DEFAULT_STAFF_CAPACITY,
      workload,
      tasks: tasks.map(({ id, label, status, detail, createdAt, updatedAt, conversationId, review }) => ({ id, label, status, detail: detail || null, createdAt, updatedAt, conversationId, review: review || null })),
      runtimeId: runtime?.runtimeId || null,
      opening: piRunOpenings.has(runId),
      running: runtime?.pi.isRunning || false,
      busy: runtime?.pi.isBusy || false,
      queuedPrompts: runtime?.pi.promptQueue?.length || 0,
    };
  }));
}

async function findRunRuntime(run) {
  if (deletingPiRuns.has(run.id)) throw new RequestError('This Pi conversation is being deleted', 409);
  const session = await findSession(run.workspace, run.sessionPath);
  const active = runtimeForSessionPath(run.workspace, session.path);
  if (active) {
    const entry = piSessions.get(active.runtimeId);
    if (entry) {
      entry.lastUsed = Date.now();
      return { entry, runtimeId: active.runtimeId };
    }
  }
  if (piRunOpenings.has(run.id)) return piRunOpenings.get(run.id);

  const opening = (async () => {
    const runtimeId = randomUUID();
    const pi = createPiRuntime(runtimeId, run.workspace);
    try { await pi.switchSession(session.path, run.workspace); }
    catch (error) {
      const entry = piSessions.get(runtimeId);
      if (entry) await retireRuntime(runtimeId, entry);
      throw error;
    }
    const entry = piSessions.get(runtimeId);
    entry.lastUsed = Date.now();
    return { entry, runtimeId };
  })();
  piRunOpenings.set(run.id, opening);
  try { return await opening; }
  finally { if (piRunOpenings.get(run.id) === opening) piRunOpenings.delete(run.id); }
}

async function listPiConversations() {
  const [sessions, availableRepositories] = await Promise.all([
    sessionsWithRunIds(preferredWorkspace, { includeRepositoryVisibility: true, includeNavigationLabel: true }),
    repositories.listRepositoryNames(),
  ]);
  return sessions.map(({ hiddenRepositories = [], ...session }) => {
    const hidden = new Set(hiddenRepositories);
    return {
      ...session,
      availableRepositories,
      visibleRepositories: availableRepositories.filter((name) => !hidden.has(name)),
    };
  });
}

async function persistPiStaffProfile(runId, profile) {
  try {
    const run = await piRunRegistry.updateRunProfile(runId, profile);
    return run && { runId: run.id, expertise: run.expertise || [], responsibilities: run.responsibilities || [], capacity: run.capacity };
  } catch (error) { throw new RequestError(error.message); }
}

async function persistPiNavigationLabel(runId, label) {
  const run = await piRunRegistry.getRun(runId);
  if (!run || run.workspace !== preferredWorkspace) return null;
  try { return await piRunRegistry.updateRunNavigationLabel(runId, label); }
  catch (error) { throw new RequestError(error.message); }
}

async function persistPiRepositoryVisibility(runId, hiddenRepositories) {
  const run = await piRunRegistry.getRun(runId);
  if (!run || run.workspace !== preferredWorkspace) return null;
  if (!Array.isArray(hiddenRepositories)) throw new RequestError('hiddenRepositories must be an array');
  const available = new Set(await repositories.listRepositoryNames());
  if (hiddenRepositories.some((name) => typeof name !== 'string' || !available.has(name))) {
    throw new RequestError('hiddenRepositories must contain managed repository names');
  }
  try { return await piRunRegistry.updateRunRepositoryVisibility(runId, hiddenRepositories); }
  catch (error) { throw new RequestError(error.message); }
}

async function updatePiStaffProfile({ runId, profile, userMessage }) {
  const run = await piRunRegistry.getRun(runId);
  if (!run) return null;
  const otherRuns = (await piRunRegistry.listRuns()).filter((candidate) => candidate.workspace === run.workspace);
  assertPiSessionProfileAuthorized({ userMessage, run, otherRuns });
  return persistPiStaffProfile(runId, profile);
}

async function createPiConversation({ name, purpose, domain, userMessage, previousAssistantMessage }) {
  assertPiSessionCreateAuthorized({ userMessage, previousAssistantMessage, purpose });
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\r\n\u0000-\u001f\u007f]/.test(name)) {
    throw new RequestError('name must be a single-line staff name up to 100 characters');
  }
  if (typeof purpose !== 'string' || !purpose.trim() || purpose.trim().length > 100 || /[\r\n\u0000-\u001f\u007f]/.test(purpose)) {
    throw new RequestError('purpose must be a single-line name up to 100 characters');
  }
  if (domain !== undefined && (typeof domain !== 'string' || !domain.trim() || domain.trim().length > 80 || /[\r\n\u0000-\u001f\u007f]/.test(domain))) {
    throw new RequestError('domain must be a single-line label up to 80 characters');
  }

  const runtimeId = randomUUID();
  try {
    const pi = createPiRuntime(runtimeId, preferredWorkspace);
    await pi.persistCurrentSession();
    await pi.setSessionName(name.trim());
    const session = await findSession(pi.workspace, pi.currentSessionPath);
    const runId = await piRunRegistry.ensureRun({ workspace: pi.workspace, sessionPath: session.path, sessionId: session.id, name: session.name, domain, purpose: purpose.trim() });
    return { runId, name: session.name || name.trim(), domain: domain?.trim() || null, purpose: purpose.trim(), workspace: pi.workspace };
  } catch (error) {
    const entry = piSessions.get(runtimeId);
    if (entry) {
      piSessions.delete(runtimeId);
      await entry.pi.stop().catch(() => {});
    }
    if (error.status) throw error;
    console.error(`Could not create a Pi run: ${error.message}`);
    throw new RequestError('Could not create a Pi conversation; check Pi Agent status', 503);
  }
}

async function renamePiConversation({ runId, name, userMessage, hostSessionEvents }) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new RequestError('runId must identify an existing Pi session');
  }
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\r\n\u0000-\u001f\u007f]/.test(name)) {
    throw new RequestError('Pi session name must be a concise single-line name up to 100 characters');
  }
  if (deletingPiRuns.has(runId)) throw new RequestError('This Pi conversation is being deleted', 409);
  return withPiRunOperation(runId, async () => {
    if (deletingPiRuns.has(runId)) throw new RequestError('This Pi conversation is being deleted', 409);
    const run = await piRunRegistry.getRun(runId);
    if (!run) return null;
    const sessions = await sessionsWithRunIds(run.workspace);
    const target = sessions.find((session) => session.runId === runId);
    if (!target) return null;
    const currentRun = await piRunRegistry.getRun(runId) || run;
    assertPiSessionRenameAuthorized({
      userMessage, run: { ...currentRun, name: target.name, sessionId: target.id },
      otherRuns: sessions.map(({ runId: id, id: sessionId, name: sessionName }) => ({ id, sessionId, name: sessionName })),
      name: name.trim(), hostSessionEvents,
    });

    return mutateSession(target, async (current) => {
      const opening = piRunOpenings.get(runId);
      if (opening) await opening;
      const runtimes = [...piSessions.values()].filter((entry) => entry.pi.currentSessionPath === current.path);
      if (runtimes.length) {
        for (const entry of runtimes) {
          await entry.pi.setSessionName(name.trim());
          entry.lastUsed = Date.now();
        }
      } else {
        const temporaryPi = new PiSession({ cwd: current.cwd, command: piCommand });
        try {
          await temporaryPi.switchSession(current.path, current.cwd);
          await temporaryPi.setSessionName(name.trim());
        } finally {
          await temporaryPi.stop();
        }
      }
      const updated = await piRunRegistry.renameRun(runId, name.trim());
      return { runId, previousName: current.name, name: updated?.name || name.trim() };
    });
  });
}

async function reportDelegatedTask({ taskId, status, summary, conversationId }) {
  const task = await piRunRegistry.getTask(taskId);
  if (!task || task.conversationId !== conversationId) return null;
  if (!['completed', 'blocked'].includes(status) || typeof summary !== 'string' || !summary.trim() || summary.length > 1000) {
    throw new RequestError('A concise completed or blocked task report is required');
  }
  if (task.status !== 'reviewing' && !(task.status === 'blocked' && status === 'blocked')) {
    throw new RequestError('Task must reach Pi review before it can be finalized', 409);
  }
  const finishedAt = new Date().toISOString();
  const updated = await piRunRegistry.updateTask(taskId, {
    status,
    summary: summary.trim(),
    review: { ...task.review, stage: 'finished', finishedAt, errorCode: null },
  });
  auditPiTaskLifecycle('task_report_persisted', {
    taskId: updated.id, runId: updated.runId, queueId: updated.queueId, status: updated.status,
    stage: updated.review?.stage, finishedAt,
  });
  return updated;
}

async function readPiConversation({ runId, limit = 10, taskId, conversationId }) {
  const run = await piRunRegistry.getRun(runId);
  if (!run) return null;
  const runtime = await findRunRuntime(run);
  runtime.entry.lastUsed = Date.now();
  let task = null;
  if (taskId) {
    task = await piRunRegistry.getTask(taskId);
    if (!task || task.runId !== runId || task.conversationId !== conversationId) throw new RequestError('Task does not belong to this exact Pi run and Friday conversation', 403);
    const queued = runtime.entry.pi.promptQueue?.some((item) => item.id === task.queueId);
    if (task.status === 'outcome-unknown' && !runtime.entry.pi.isBusy && !queued) {
      const startedAt = new Date().toISOString();
      task = await piRunRegistry.updateTask(task.id, {
        status: 'reviewing',
        detail: 'Manually reopened for exact-task review after the outcome became unknown; Pi was not replayed.',
        review: { ...task.review, stage: 'active', startedAt, errorCode: null },
      });
      auditPiTaskLifecycle('manual_review_started', { taskId: task.id, runId: task.runId, queueId: task.queueId, stage: 'active', startedAt });
    }
  }
  const messages = await runtime.entry.pi.history(limit);
  return {
    runId: run.id,
    name: run.name || 'Pi conversation',
    busy: runtime.entry.pi.isBusy,
    ...(task ? { task: { id: task.id, label: task.label, queueId: task.queueId, status: task.status, detail: task.detail || null, review: task.review || null } } : {}),
    messages: messages.map((message) => ({
      ...message,
      content: message.content.length > 4000 ? `${message.content.slice(0, 4000)}… [truncated]` : message.content,
    })),
  };
}

async function deletePiConversation({ runId, conversationId, userMessage, previousAssistantMessage }) {
  if (deletingPiRuns.has(runId)) throw new RequestError('This Pi conversation is already being deleted', 409);
  deletingPiRuns.add(runId);
  try {
    let run = await piRunRegistry.getRun(runId);
    if (!run) return null;
    const listedSessions = await sessionsWithRunIds(run.workspace);
    const listedSession = listedSessions.find((session) => session.runId === runId);
    if (!listedSession) return null;
    run = await piRunRegistry.getRun(runId) || run;
    const otherRuns = listedSessions.map((session) => ({ id: session.runId, sessionId: session.id, name: session.name }));
    assertPiSessionDeleteAuthorized({ userMessage, previousAssistantMessage, run, otherRuns });
    const session = await findSession(run.workspace, run.sessionPath);
    return await withPiRunOperation(run.id, async () => {
      const linkedRun = await piRunRegistry.getLinkedRun(conversationId);
      const runtimes = [...piSessions.values()].filter((entry) => entry.pi.currentSessionPath === session.path);
      assertPiSessionDeletable({ runId: run.id, linkedRunId: linkedRun?.id, opening: piRunOpenings.has(run.id), runtimes });
      await mutateSession(session, async (current) => {
        const currentLink = await piRunRegistry.getLinkedRun(conversationId);
        const currentRuntimes = [...piSessions.values()].filter((entry) => entry.pi.currentSessionPath === current.path);
        await deletePiSessionWithPolicy({
          runId: run.id, run, otherRuns, userMessage, previousAssistantMessage,
          linkedRunId: currentLink?.id, opening: piRunOpenings.has(run.id), runtimes: currentRuntimes,
          remove: () => unlink(current.path),
        });
      });
      await piRunRegistry.deleteRun(run.id);
      return { deleted: true, runId: run.id, name: run.name || 'Pi conversation' };
    });
  } finally {
    deletingPiRuns.delete(runId);
  }
}

async function getPiRunStatus(runId) {
  const run = await piRunRegistry.getRun(runId);
  if (!run) return null;
  const runtime = runtimeForSessionPath(run.workspace, run.sessionPath)?.pi;
  const exists = (await listSessions(run.workspace)).some((session) => session.path === run.sessionPath);
  return {
    runId: run.id,
    name: run.name || 'Pi conversation',
    workspace: run.workspace,
    exists,
    opening: piRunOpenings.has(run.id),
    running: runtime?.pi.isRunning || false,
    busy: runtime?.pi.isBusy || false,
    queuedPrompts: runtime?.pi.promptQueue?.length || 0,
  };
}

async function withPiRunOperation(runId, operation) {
  const previous = piRunOperations.get(runId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  piRunOperations.set(runId, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (piRunOperations.get(runId) === current) piRunOperations.delete(runId);
  }
}

async function stopPiRun({ runId, userMessage }) {
  const run = await piRunRegistry.getRun(runId);
  if (!run) return null;
  const otherRuns = (await piRunRegistry.listRuns()).filter((candidate) => candidate.workspace === run.workspace);
  assertPiRunStopAuthorized({ userMessage, run, otherRuns });
  return withPiRunOperation(run.id, async () => {
    const opening = piRunOpenings.get(run.id);
    if (opening) { try { await opening; } catch {} }
    const runtime = [...piSessions.values()].find((entry) => entry.pi.currentSessionPath === run.sessionPath);
    if (!runtime) return { runId, stopped: false, running: false, queuedPrompts: 0 };
    const cleared = runtime.pi.clearPromptQueue();
    const aborted = await runtime.pi.abort();
    runtime.lastUsed = Date.now();
    const stopped = Boolean(cleared || aborted);
    if (stopped) await piRunRegistry.updateTasksForRun(run.id, 'blocked', 'Stopped at the user’s request.');
    return { runId, stopped, aborted, clearedPrompts: cleared, queuedPrompts: runtime.pi.promptQueue.length };
  });
}

async function waitForPiPrompt({ runId, queueId, timeoutMs, signal }) {
  const task = await piRunRegistry.getTaskForPrompt(runId, queueId);
  const run = await piRunRegistry.getRun(runId);
  if (!run) {
    if (task) await piRunRegistry.updateTask(task.id, { status: 'outcome-unknown', detail: 'Pi run is no longer available.' });
    return { runId, queueId, status: 'not_found', taskId: task?.id };
  }
  const entry = [...piSessions.values()].find((candidate) => candidate.pi.currentSessionPath === run.sessionPath);
  if (!entry) {
    if (task) await piRunRegistry.updateTask(task.id, { status: 'outcome-unknown', detail: 'Pi runtime is unavailable; task was not replayed.' });
    return { runId, queueId, status: 'not_found', taskId: task?.id };
  }
  entry.lastUsed = Date.now();
  const isQueued = entry.pi.promptQueue.some((item) => item.id === queueId);
  if (task) await piRunRegistry.updateTask(task.id, { status: isQueued ? 'queued' : 'running' });
  const outcome = await entry.pi.waitForPrompt(queueId, { timeoutMs, signal });
  const latestTask = task ? await piRunRegistry.getTask(task.id) : null;
  if (task && !['completed', 'blocked'].includes(latestTask?.status)) {
    const status = outcome.status === 'completed' ? 'reviewing'
      : outcome.status === 'failed' ? 'blocked'
        : ['timed_out', 'cancelled', 'not_found'].includes(outcome.status) ? 'outcome-unknown' : 'blocked';
    await piRunRegistry.updateTask(task.id, {
      status,
      ...(status === 'blocked' ? { detail: 'Pi reported a failed task. Review the result before retrying.' } : {}),
      ...(status === 'outcome-unknown' ? { detail: 'The wait ended before the Pi task reached a known result.' } : {}),
    });
  }
  return { runId, ...outcome, ...(task ? { taskId: task.id } : {}) };
}

async function enqueuePiPrompt({ conversationId, runId, taskName, prompt }) {
  const run = assertPiRunAcceptsPrompt(await resolveSelectedPiRun({ runId, conversationId, runRegistry: piRunRegistry }));
  if (typeof taskName !== 'string' || !taskName.trim() || taskName.trim().length > 100) throw new RequestError('taskName is required and must be at most 100 characters');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) throw new RequestError('prompt must be between 1 and 20000 characters');
  if (deletingPiRuns.has(run.id)) throw new RequestError('This Pi conversation is being deleted', 409);
  try { await findSession(run.workspace, run.sessionPath); }
  catch { throw new RequestError('The selected Pi conversation no longer exists; choose another conversation', 404); }

  return withPiRunOperation(run.id, async () => {
    if (deletingPiRuns.has(run.id)) throw new RequestError('This Pi conversation is being deleted', 409);
    assertPiRunAcceptsPrompt(await resolveSelectedPiRun({ runId: run.id, runRegistry: piRunRegistry }));
    await piRunRegistry.linkConversation(conversationId, run.id);
    let runtime;
    try { runtime = await findRunRuntime(run); }
    catch (error) {
      console.error(`Could not open Pi run ${run.id}: ${error.message}`);
      throw new RequestError(`Could not open Pi run ${run.id}; check Pi Agent status`, 503);
    }
    const registeredTasks = await piRunRegistry.listTasks({ runId: run.id });
    const assigned = registeredTasks.filter((task) => ['queued', 'running', 'reviewing', 'outcome-unknown'].includes(task.status)).length;
    const live = Number(runtime.entry.pi.isBusy) + (runtime.entry.pi.promptQueue?.length || 0);
    const workload = Math.max(assigned, live);
    const capacity = Number.isInteger(run.capacity) ? run.capacity : DEFAULT_STAFF_CAPACITY;
    if (workload >= capacity) throw new RequestError(`Pi staff capacity reached for ${run.name || run.id} (${workload}/${capacity} open tasks).`, 409);
    const queueId = randomUUID();
    const task = await piRunRegistry.createTask({ conversationId, runId: run.id, queueId, label: taskName });
    try {
      const queued = runtime.entry.pi.enqueuePrompt(prompt.trim(), queueId);
      runtime.entry.lastUsed = Date.now();
      return { queued: true, taskId: task.id, runId: run.id, queueId: queued.id, position: queued.position };
    } catch (error) {
      await piRunRegistry.updateTask(task.id, { status: 'blocked', detail: 'Pi rejected the prompt before it could be queued.' });
      throw error;
    }
  });
}

async function mutateSession(session, operation) {
  if (sessionMutations.has(session.path)) {
    throw new RequestError('This session is already being changed', 409);
  }
  sessionMutations.add(session.path);
  try {
    const current = await findSession(session.cwd, session.path);
    return await operation(current);
  } finally {
    sessionMutations.delete(session.path);
  }
}

async function serveStatic(pathname, response) {
  const filenames = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/login': 'login.html',
    '/login.html': 'login.html',
    '/login.js': 'login.js',
    '/app.js': 'app.js',
    '/friday-chat.js': 'friday-chat.js',
    '/friday-pi-session-cards.js': 'friday-pi-session-cards.js',
    '/local-calendar.js': 'local-calendar.js',
    '/calendar-view.js': 'calendar-view.js',
    '/markdown.js': 'markdown.js',
    '/dashboard-format.js': 'dashboard-format.js',
    '/highlight.min.js': '../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/vendor/highlight.min.js',
    '/styles.css': 'styles.css',
    '/friday-logo.png': 'friday-logo.png',
    '/friday-logo.svg': 'friday-logo.svg',
  };
  const filename = filenames[pathname];
  if (!filename) {
    return false;
  }

  const body = await readFile(join(publicRoot, filename));
  response.writeHead(200, {
    'Content-Type': contentTypes[filename.slice(filename.lastIndexOf('.'))] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  response.end(body);
  return true;
}

async function currentContextUsage(pi) {
  try { return await pi.getContextUsage(); }
  catch (error) { if (error.status === 409) return null; throw error; }
}

async function waitForConversationReview(conversationId) {
  await completionReviews.waitFor(conversationId);
}

async function handleFridayRequest(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/friday/memory/graph') {
    sendJson(response, 200, await fridayMemory.graph());
    return;
  }
  if (request.method === 'POST' && pathname === '/api/friday/tasks/cleanup-stale-completed-review-detail') {
    const body = await readJson(request);
    if (body.confirmation !== 'clear-only-exact-obsolete-detail-from-completed-tasks') {
      throw new RequestError('Explicit cleanup confirmation is required', 400);
    }
    const backupFile = join(syncStateRoot, `pi-runs.before-review-detail-cleanup-${randomUUID()}.json`);
    sendJson(response, 200, await piRunRegistry.clearStaleCompletedReviewDetails(backupFile));
    return;
  }
  const pi = await getFridayPi();
  if (request.method === 'GET' && pathname === '/api/friday/status') {
    const taskList = await piRunRegistry.listTasks({ conversationId: pi.currentSessionId });
    const activeTask = taskList.find((task) => ['queued', 'running', 'reviewing', 'outcome-unknown'].includes(task.status));
    sendJson(response, 200, {
      running: pi.isRunning,
      delegatedTask: activeTask || taskList[0] || null,
      tasks: taskList.slice(0, 30),
      busy: pi.isBusy,
      canAbort: pi.canAbort,
      chatQueue: pi.getChatQueue(),
      sessionPath: pi.currentSessionPath,
      model: modelForClient(pi.currentModel),
      thinkingLevel: pi.currentThinkingLevel,
      contextUsage: await currentContextUsage(pi),
    });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/friday/abort') {
    if (!pi.canAbort) throw new RequestError('Friday is not currently responding', 409);
    sendJson(response, 200, { aborted: await pi.abort() });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/friday/models') {
    sendJson(response, 200, {
      models: (await pi.availableModels()).map(modelForClient),
      current: modelForClient(pi.currentModel),
    });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/friday/model') {
    await waitForConversationReview(pi.currentSessionId);
    const body = await readJson(request);
    if (typeof body.provider !== 'string' || typeof body.modelId !== 'string' || !body.provider || !body.modelId) {
      throw new RequestError('provider and modelId are required');
    }
    sendJson(response, 200, { model: modelForClient(await pi.setModel(body.provider, body.modelId)) });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/friday/thinking-levels') {
    sendJson(response, 200, {
      levels: await pi.availableThinkingLevels(),
      current: pi.currentThinkingLevel,
    });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/friday/thinking-level') {
    await waitForConversationReview(pi.currentSessionId);
    const body = await readJson(request);
    if (typeof body.level !== 'string' || !body.level) {
      throw new RequestError('level is required');
    }
    await pi.setThinkingLevel(body.level);
    sendJson(response, 200, { level: pi.currentThinkingLevel });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/friday/sessions') {
    sendJson(response, 200, await pi.listSessions());
    return;
  }
  if (request.method === 'GET' && pathname === '/api/friday/pi-conversations') {
    sendJson(response, 200, { workspace: preferredWorkspace, sessions: await listPiConversations() });
    return;
  }
  const labelMatch = pathname.match(/^\/api\/friday\/pi-conversations\/([0-9a-f-]{36})\/label$/i);
  if (labelMatch && request.method === 'PATCH') {
    const body = await readJson(request);
    if (typeof body.label !== 'string') throw new RequestError('label must be a string');
    const updated = await persistPiNavigationLabel(labelMatch[1], body.label);
    sendJson(response, updated ? 200 : 404, updated ? { runId: updated.id, navigationLabel: updated.navigationLabel || null } : { error: 'Pi conversation not found' });
    return;
  }
  const profileMatch = pathname.match(/^\/api\/friday\/pi-conversations\/([0-9a-f-]{36})\/profile$/i);
  if (profileMatch && request.method === 'PATCH') {
    const body = await readJson(request);
    const profile = { expertise: body.expertise, responsibilities: body.responsibilities, capacity: body.capacity };
    const updated = await persistPiStaffProfile(profileMatch[1], profile);
    sendJson(response, updated ? 200 : 404, updated || { error: 'Pi conversation not found' });
    return;
  }
  const repositoryVisibilityMatch = pathname.match(/^\/api\/friday\/pi-conversations\/([0-9a-f-]{36})\/repository-visibility$/i);
  if (repositoryVisibilityMatch && request.method === 'PATCH') {
    const body = await readJson(request);
    const updated = await persistPiRepositoryVisibility(repositoryVisibilityMatch[1], body.hiddenRepositories);
    sendJson(response, updated ? 200 : 404, updated ? { runId: updated.id, hiddenRepositories: updated.hiddenRepositories || [] } : { error: 'Pi conversation not found' });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/friday/sessions') {
    await waitForConversationReview(pi.currentSessionId);
    const id = await pi.newSession();
    sendJson(response, 200, { id });
    return;
  }
  const fridaySessionMatch = pathname.match(/^\/api\/friday\/sessions\/([A-Za-z0-9-]{1,100})(\/open)?$/);
  if (fridaySessionMatch && fridaySessionMatch[2] && request.method === 'POST') {
    await Promise.all([pi.currentSessionId, fridaySessionMatch[1]].filter(Boolean).map(waitForConversationReview));
    const id = await pi.openSession(fridaySessionMatch[1]);
    sendJson(response, 200, { id });
    return;
  }
  if (fridaySessionMatch && !fridaySessionMatch[2] && request.method === 'PATCH') {
    await waitForConversationReview(fridaySessionMatch[1]);
    const body = await readJson(request);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) throw new RequestError('name must be between 1 and 100 characters');
    sendJson(response, 200, await pi.renameSession(fridaySessionMatch[1], body.name));
    return;
  }
  if (fridaySessionMatch && !fridaySessionMatch[2] && request.method === 'DELETE') {
    await waitForConversationReview(fridaySessionMatch[1]);
    const result = await pi.deleteSession(fridaySessionMatch[1]);
    await piRunRegistry.unlinkConversation(fridaySessionMatch[1]);
    sendJson(response, 200, result);
    return;
  }
  if (request.method === 'GET' && pathname === '/api/friday/history') {
    const url = new URL(request.url, 'http://localhost');
    const allMessages = await pi.history();
    const sessionId = String(pi.currentSessionId || '');
    const requestedSession = url.searchParams.get('sessionId');
    const afterId = url.searchParams.get('afterId');
    const afterRevision = url.searchParams.get('afterRevision');
    const afterPrefix = url.searchParams.get('afterPrefix');
    let messages = allMessages;
    let reset = true;
    let unchanged = false;
    if (url.searchParams.get('full') !== '1' && requestedSession === sessionId) {
      if (!afterId && allMessages.length === 0) {
        messages = [];
        reset = false;
        unchanged = true;
      } else if (afterId) {
        const cursorIndex = allMessages.findIndex((message) => message.id === afterId);
        if (cursorIndex >= 0 && allMessages[cursorIndex].prefixRevision === afterPrefix) {
          reset = false;
          const cursorChanged = allMessages[cursorIndex].revision !== afterRevision;
          messages = allMessages.slice(cursorIndex + (cursorChanged ? 0 : 1));
          unchanged = messages.length === 0;
        }
      }
    }
    const latest = allMessages.at(-1);
    sendJson(response, 200, {
      messages, sessionId, reset, incremental: !reset, unchanged,
      latestId: latest?.id || null, latestRevision: latest?.revision || null,
    });
    return;
  }
  const cancelChatMatch = pathname.match(/^\/api\/friday\/chat\/([0-9a-f-]{36})\/cancel$/i);
  if (request.method === 'POST' && cancelChatMatch) {
    const cancelled = pi.cancelQueuedChat(cancelChatMatch[1]);
    if (!cancelled) throw new RequestError('Only a queued Friday message can be cancelled', 409);
    sendJson(response, 200, { id: cancelChatMatch[1], cancelled: true });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/friday/chat') {
    const body = await readJson(request);
    if (typeof body.message !== 'string' || !body.message.trim()) {
      throw new RequestError('message is required');
    }
    if (body.message.length > 20_000) {
      throw new RequestError('message is too long');
    }
    const userMessage = body.message.trim();
    const conversationId = pi.currentSessionId;
    const job = pi.enqueueChat(userMessage, {
      conversationId,
      beforeRun: () => waitForConversationReview(conversationId),
      onComplete: async (reply) => {
        const sensitiveCalendarDataUsed = calendarContentAccessed;
        calendarContentAccessed = false;
        if (sensitiveCalendarDataUsed) return;
        const now = new Date();
        try {
          await fridayMemory.appendDailyLog({
            date: now.toISOString().slice(0, 10),
            timestamp: now.toISOString(),
            conversationId,
            userMessage,
            fridayReply: reply,
          });
        } catch (error) {
          console.error(`Friday daily log write failed: ${error.message}`);
        }
      },
    });
    sendJson(response, 202, job);
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}

async function readSyncConfig() {
  try {
    const value = JSON.parse(await readFile(syncConfigFile, 'utf8'));
    return {
      owner: typeof value.owner === 'string' ? value.owner : '',
      repo: typeof value.repo === 'string' ? value.repo : '',
      lastSync: typeof value.lastSync === 'string' ? value.lastSync : null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { owner: '', repo: '', lastSync: null };
    throw error;
  }
}

async function writeSyncConfig(value) {
  const file = syncConfigFile;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function performSync() {
  const state = syncState.friday;
  if (state.busy) return null;
  state.busy = true;
  state.error = null;
  state.promise = (async () => {
    const config = await readSyncConfig();
    validateGitHubSyncTarget(config.owner, config.repo);
    const result = await syncGitHubSnapshot({
      directory: paths.root,
      snapshotName: '.friday',
      managedRepos: [repositories.directory],
      excludedPaths: [relative(paths.root, syncConfigFile).split(sep).join('/'), 'memory', 'data/calendar'],
      stateFile: syncStateFile,
      owner: config.owner,
      repo: config.repo,
    });
    config.lastSync = new Date().toISOString();
    await writeSyncConfig(config);
    return { ...result, lastSync: config.lastSync };
  })();
  try {
    return await state.promise;
  } catch (error) {
    state.error = error.message || 'Sync failed';
    throw error;
  } finally {
    state.busy = false;
    state.promise = null;
  }
}

async function runScheduledSyncs() {
  try {
    const config = await readSyncConfig();
    if (!config.owner || !config.repo || syncState.friday.busy) return;
    const result = await performSync();
    if (result) console.log(`Friday GitHub sync completed${result.pushed ? ' (pushed)' : ''}${result.pulled ? ` (pulled ${result.pulled} files)` : ''}`);
  } catch (error) {
    console.error(`Friday scheduled GitHub sync failed: ${error.message}`);
  }
}

function scheduleGitHubSyncs() {
  githubSyncTimer = setTimeout(() => {
    void runScheduledSyncs()
      .catch((error) => console.error(`scheduled GitHub sync failed: ${error.message}`))
      .finally(() => { if (!shuttingDown) scheduleGitHubSyncs(); });
  }, millisecondsUntilNextQuarterHour());
  githubSyncTimer.unref();
}

async function githubStatus() {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000, maxBuffer: 64 * 1024 });
  } catch { return { available: false, authenticated: false }; }
  try {
    await execFileAsync('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 5000, maxBuffer: 64 * 1024 });
    return { available: true, authenticated: true };
  } catch { return { available: true, authenticated: false }; }
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && ['/login', '/login.html'].includes(pathname)) {
    if (isAppAuthenticated(request)) redirect(response, '/');
    else await serveStatic(pathname, response);
    return;
  }
  if (request.method === 'GET' && pathname === '/login.js') {
    await serveStatic(pathname, response);
    return;
  }
  if (request.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(request);
    const attempt = loginRateLimit(request);
    if (attempt.blocked) {
      response.setHeader('Retry-After', String(attempt.retryAfter));
      sendJson(response, 429, { error: 'Too many login attempts. Try again later.' });
      return;
    }
    if (!passwordMatches(body.password)) {
      recordFailedLogin(attempt.address);
      sendJson(response, 401, { error: 'Incorrect password' });
      return;
    }
    failedLogins.delete(attempt.address);
    const previousId = appSessionId(request);
    if (previousId) appSessions.delete(previousId);
    const now = Date.now();
    for (const [id, session] of appSessions) {
      if (now - session.lastSeenAt > appSessionIdleTtlMs) appSessions.delete(id);
    }
    const sessionId = randomBytes(32).toString('base64url');
    appSessions.set(sessionId, { lastSeenAt: now });
    response.setHeader('Set-Cookie', appSessionCookieHeader(sessionId));
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/logout') {
    const sessionId = appSessionId(request);
    if (sessionId) appSessions.delete(sessionId);
    response.setHeader('Set-Cookie', appSessionCookieHeader('', 0));
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (!isAppAuthenticated(request)) {
    if (pathname.startsWith('/api/')) sendJson(response, 401, { error: 'Login required' });
    else redirect(response, '/login');
    return;
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.headers.origin) {
    let origin;
    try { origin = new URL(request.headers.origin); }
    catch { throw new RequestError('Invalid request origin', 403); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) {
      throw new RequestError('Cross-origin request rejected', 403);
    }
  }

  if (pathname === '/api/calendar/events' && request.method === 'GET') {
    sendJson(response, 200, { events: await localCalendar.list() });
    return;
  }
  if (pathname === '/api/calendar/events' && request.method === 'POST') {
    sendJson(response, 201, { event: await localCalendar.create(await readJson(request, 16 * 1024)) });
    return;
  }
  const calendarEventRoute = pathname.match(/^\/api\/calendar\/events\/([0-9a-f-]{36})$/i);
  if (calendarEventRoute && request.method === 'PUT') {
    const event = await localCalendar.update(calendarEventRoute[1], await readJson(request, 16 * 1024));
    if (!event) throw new RequestError('Calendar event not found', 404);
    sendJson(response, 200, { event });
    return;
  }
  if (calendarEventRoute && request.method === 'DELETE') {
    const event = await localCalendar.delete(calendarEventRoute[1]);
    if (!event) throw new RequestError('Calendar event not found', 404);
    sendJson(response, 200, { deleted: true, id: event.id });
    return;
  }

  if (request.method === 'GET' && pathname === '/pi-not-installed') {
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi is not installed — Friday</title><main style="font:1rem system-ui;max-width:36rem;margin:10vh auto;padding:1rem"><h1>Pi is not installed</h1><p>Install the <a href="https://pi.dev">Pi CLI</a> on the server and ensure <code>pi</code> is on PATH, or set <code>PI_COMMAND</code> to its executable path. Then restart Friday.</p><a href="/">Back to Friday</a></main></html>');
    return;
  }
  if (request.method === 'GET' && pathname === '/api/system/github') {
    sendJson(response, 200, await githubStatus());
    return;
  }
  const syncRoute = pathname.match(/^\/api\/friday\/sync\/(settings|run)$/);
  if (syncRoute) {
    const action = syncRoute[1];
    const state = syncState.friday;
    if (action === 'settings' && request.method === 'GET') {
      const config = await readSyncConfig();
      sendJson(response, 200, { ...config, status: state.busy ? 'Syncing…' : config.owner ? 'Ready' : 'Not configured', error: state.error });
      return;
    }
    if (action === 'settings' && request.method === 'POST') {
      const body = await readJson(request);
      try { validateGitHubSyncTarget(body.owner, body.repo); }
      catch { throw new RequestError('Enter a valid GitHub owner and repository'); }
      if (state.busy) throw new RequestError('GitHub sync is already running', 409);
      const previous = await readSyncConfig();
      const config = { owner: body.owner, repo: body.repo, lastSync: previous.owner === body.owner && previous.repo === body.repo ? previous.lastSync : null };
      await writeSyncConfig(config);
      state.error = null;
      void performSync().catch((error) => console.error(`Friday automatic GitHub sync failed: ${error.message}`));
      sendJson(response, 200, { ...config, status: 'Syncing…', error: null });
      return;
    }
    if (action === 'run' && request.method === 'POST') {
      if (state.busy) throw new RequestError('GitHub sync is already running', 409);
      const config = await readSyncConfig();
      try { validateGitHubSyncTarget(config.owner, config.repo); }
      catch { throw new RequestError('Configure a private GitHub repository in agent Settings first'); }
      let result;
      try { result = await performSync(); }
      catch { throw new RequestError(`GitHub sync failed: ${state.error}`, 502); }
      if (!result) throw new RequestError('GitHub sync is already running', 409);
      sendJson(response, 200, result);
      return;
    }
    throw new RequestError('Not found', 404);
  }
  if (request.method === 'GET' && pathname === '/api/finances') {
    sendJson(response, 200, { entries: await finances.list() });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/finances') {
    const body = await readJson(request);
    try { sendJson(response, 201, { entry: await finances.add(body) }); }
    catch (error) { throw new RequestError(error.message, 400); }
    return;
  }
  const financeEntryRoute = pathname.match(/^\/api\/finances\/([^/]+)$/);
  if (request.method === 'PATCH' && financeEntryRoute) {
    const body = await readJson(request);
    try {
      const entry = await finances.updateEntry(financeEntryRoute[1], body);
      if (!entry) throw new RequestError('Entry not found', 404);
      sendJson(response, 200, { entry });
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(error.message, 400);
    }
    return;
  }
  if (request.method === 'DELETE' && financeEntryRoute) {
    if (!await finances.remove(financeEntryRoute[1])) throw new RequestError('Entry not found', 404);
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (request.method === 'POST' && pathname === '/api/repos/pull') {
    const body = await readJson(request);
    try {
      sendJson(response, 200, await repositories.pullRepository(body.name));
    } catch (error) {
      const status = error.code === 'DIRTY' || error.code === 'BUSY' ? 409
        : error.code === 'ENOENT' ? 404
          : error.code === 'INVALID' ? 400 : 502;
      throw new RequestError(error.message || 'Git pull failed', status);
    }
    return;
  }
  if (request.method === 'GET' && pathname === '/api/repos') {
    sendJson(response, 200, { repos: await repositories.listRepositories() });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/repos') {
    const body = await readJson(request);
    if (typeof body.url !== 'string') throw new RequestError('url is required');
    try { sendJson(response, 201, { repo: await repositories.cloneRepository(body.url) }); }
    catch (error) { throw new RequestError(error.message, 400); }
    return;
  }
  const scopedFiles = pathname.match(/^\/api\/(friday|pi)\/files(\/content)?$/);
  if (scopedFiles && request.method === 'GET') {
    const root = scopedFiles[1];
    const path = url.searchParams.get('path') || '';
    try {
      sendJson(response, 200, scopedFiles[2]
        ? await readAgentFile({ root, path })
        : await listAgentFiles({ root, path }));
    } catch (error) {
      throw new RequestError(error.message, 400);
    }
    return;
  }
  if (scopedFiles?.[2] && request.method === 'PUT') {
    const body = await readJson(request, 2 * 1024 * 1024);
    try { sendJson(response, 200, await writeAgentFile({ root: scopedFiles[1], path: url.searchParams.get('path'), content: body.content })); }
    catch (error) { throw new RequestError(error.message, 400); }
    return;
  }
  if (request.method === 'GET' && pathname === '/api/notes') {
    sendJson(response, 200, { notes: (await browseNotes({ root: paths.notesDir })).map((path) => ({ name: path, path })) });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/notes/content') {
    const content = await readNote(url.searchParams.get('path'), { root: paths.notesDir });
    if (content === null) throw new RequestError('Note not found', 404);
    sendJson(response, 200, { content });
    return;
  }
  const authRoute = pathname.match(/^\/api\/(friday|pi)\/auth(?:\/(login|logout|flow))?$/);
  if (authRoute) {
    const service = authRoute[1] === 'friday' ? fridayAuth : piAuth;
    const action = authRoute[2];
    if (authRoute[1] === 'friday' && ['login', 'logout'].includes(action) && fridayPi?.isBusy) {
      throw new RequestError('Friday is busy; retry after the current reply', 409);
    }
    if (!action && request.method === 'GET') {
      sendJson(response, 200, { providers: await Promise.all(['openai-codex', 'openai'].map((id) => service.status(id))) });
      return;
    }
    if (action === 'login' && request.method === 'POST') {
      const body = await readJson(request);
      if (body.type === 'api_key' && body.provider === 'openai' && typeof body.key === 'string' && body.key.length <= 4096) {
        const result = await service.loginApiKey(body.provider, body.key);
        if (authRoute[1] === 'friday') await resetFridayAfterAuth();
        sendJson(response, 200, result); return;
      }
      if (body.type === 'oauth' && body.provider === 'openai-codex') {
        sendJson(response, 202, { token: (await service.beginOAuth(body.provider)).id }); return;
      }
      throw new RequestError('Unsupported provider or login method');
    }
    if (action === 'logout' && request.method === 'POST') {
      const body = await readJson(request);
      if (!['openai', 'openai-codex'].includes(body.provider)) throw new RequestError('Unsupported provider');
      await (await service.runtime()).logout(body.provider);
      if (authRoute[1] === 'friday') await resetFridayAfterAuth();
      sendJson(response, 200, { ok: true }); return;
    }
    if (action === 'flow' && request.method === 'GET') {
      const state = await service.next(url.searchParams.get('token'));
      if (state.ok && !state.step && authRoute[1] === 'friday') await resetFridayAfterAuth();
      sendJson(response, 200, state.step ? { ...state.step } : state.ok ? { complete: true } : { pending: state.error === 'Pending', error: state.error });
      return;
    }
    if (action === 'flow' && request.method === 'POST') {
      const body = await readJson(request);
      sendJson(response, 200, await service.answer(body.token, body.response)); return;
    }
    if (action === 'flow' && request.method === 'DELETE') {
      sendJson(response, 200, { cancelled: service.cancel(url.searchParams.get('token')) }); return;
    }
    throw new RequestError('Not found', 404);
  }
  if (request.method === 'GET' && pathname === '/api/friday/settings') {
    sendJson(response, 200, { fridayChat: {
      directory: fridayChatDir,
      sessionsDirectory: fridaySessionDir,
      sessionPath: fridayPi?.currentSessionPath || null,
      model: modelForClient(fridayPi?.currentModel),
      running: fridayPi?.isRunning || false,
      busy: fridayPi?.isBusy || false,
    } });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/system/settings') {
    sendJson(response, 200, { host, port, piCommand, systemUsage: await getSystemUsage() });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/system/temperature') {
    sendJson(response, 200, await hostTemperature.read());
    return;
  }
  if (request.method === 'POST' && pathname === '/api/system/restart') {
    if (!process.env.INVOCATION_ID) throw new RequestError('Friday must be managed by systemd with automatic restart enabled', 409);
    if (restartScheduled) throw new RequestError('A Friday restart is already scheduled', 409);
    restartScheduled = true;
    sendJson(response, 202, { scheduled: true });
    setTimeout(() => {
      void shutdown('UI restart request', true).finally(() => process.exit(0));
    }, 1500);
    return;
  }
  if (request.method === 'GET' && pathname === '/api/devices') {
    sendJson(response, 200, await listDevices());
    return;
  }
  if (pathname.startsWith('/api/friday/')) {
    await handleFridayRequest(request, response, pathname);
    return;
  }

  if (request.method === 'GET' && await serveStatic(pathname, response)) return;
  if (pathname === '/api/pi/repos' || pathname === '/api/pi/repos/pull') throw new RequestError('Not found', 404);
  if (request.method === 'GET' && pathname === '/api/pi/update-status') {
    sendJson(response, 200, { ...piUpdateStatus });
    return;
  }

  if (request.method === 'POST' && ['/api/pi/extensions/update', '/api/pi/runtime/update'].includes(pathname)) {
    const body = await readJson(request, 1024);
    if (body.confirmed !== true || Object.keys(body).length !== 1) {
      throw new RequestError('Explicit confirmation is required for Pi updates');
    }
    const pi = piForRequest(request);
    const operation = pathname === '/api/pi/extensions/update' ? 'extensions' : 'runtime';
    sendJson(response, 200, await updatePi(operation, pi.workspace));
    return;
  }

  const pi = piForRequest(request);

  if (request.method === 'GET' && pathname === '/api/status') {
    sendJson(response, 200, {
      workspace: pi.workspace,
      preferredWorkspace,
      sessionPath: pi.currentSessionPath,
      model: modelForClient(pi.currentModel),
      thinkingLevel: pi.currentThinkingLevel,
      piRunning: pi.isRunning,
      busy: pi.isBusy,
      canAbort: pi.canAbort,
      contextUsage: await currentContextUsage(pi),
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/models') {
    const models = await pi.availableModels();
    sendJson(response, 200, {
      models: models.map(modelForClient),
      current: modelForClient(pi.currentModel),
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/model') {
    const body = await readJson(request);
    if (typeof body.provider !== 'string' || typeof body.modelId !== 'string' || !body.provider || !body.modelId) {
      throw new RequestError('provider and modelId are required');
    }

    const model = await pi.setModel(body.provider, body.modelId);
    sendJson(response, 200, { model: modelForClient(model) });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/thinking-levels') {
    sendJson(response, 200, {
      levels: await pi.availableThinkingLevels(),
      current: pi.currentThinkingLevel,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/thinking-level') {
    const body = await readJson(request);
    if (typeof body.level !== 'string' || !body.level) {
      throw new RequestError('level is required');
    }

    await pi.setThinkingLevel(body.level);
    sendJson(response, 200, { level: pi.currentThinkingLevel });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/pi/settings') {
    const piPackages = await listInstalledPiPackages(pi.workspace, true);
    sendJson(response, 200, {
      workspace: pi.workspace,
      preferredWorkspace,
      sessionPath: pi.currentSessionPath,
      model: modelForClient(pi.currentModel),
      thinkingLevel: pi.currentThinkingLevel,
      piRunning: pi.isRunning,
      busy: pi.isBusy,
      piPackages: piPackages.packages,
      piPackagesError: piPackages.error,
    });
    return;
  }
  if (request.method === 'GET' && pathname === '/api/settings') {
    const piPackages = await listInstalledPiPackages(pi.workspace);
    sendJson(response, 200, {
      host,
      port,
      piCommand,
      fridayChat: {
        directory: fridayChatDir,
        sessionsDirectory: fridaySessionDir,
        sessionPath: fridayPi?.currentSessionPath || null,
        model: modelForClient(fridayPi?.currentModel),
        running: fridayPi?.isRunning || false,
        busy: fridayPi?.isBusy || false,
      },
      workspaceRoots,
      workspace: pi.workspace,
      preferredWorkspace,
      sessionPath: pi.currentSessionPath,
      model: modelForClient(pi.currentModel),
      thinkingLevel: pi.currentThinkingLevel,
      systemUsage: await getSystemUsage(),
      piRunning: pi.isRunning,
      busy: pi.isBusy,
      piPackages: piPackages.packages,
      piPackagesError: piPackages.error,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/settings/workspace') {
    if (process.env.FRIDAY_WORKSPACE) throw new RequestError('Workspace is controlled by FRIDAY_WORKSPACE; change the environment variable and restart Friday', 409);
    const body = await readJson(request);
    const workspace = await resolveWorkspace(body.workspace);
    let workspacePi = pi;
    let runtimeId = clientIdFor(request);
    if (pi.workspace !== workspace && (pi.isBusy || runtimeHasOtherViewers(runtimeId, viewerIdFor(request)))) {
      runtimeId = randomUUID();
      workspacePi = createPiRuntime(runtimeId, workspace);
    } else if (pi.workspace !== workspace) {
      await pi.reset(workspace);
    }
    await persistWorkspace(workspace);
    sendJson(response, 200, {
      workspace: workspacePi.workspace,
      preferredWorkspace,
      runtimeId,
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/workspaces') {
    sendJson(response, 200, {
      workspaces: await listWorkspaceSuggestions(url.searchParams.get('prefix') || ''),
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/sessions') {
    const workspace = url.searchParams.has('cwd')
      ? await resolveWorkspace(url.searchParams.get('cwd'))
      : pi.workspace;
    const runtimes = runningPiSessions(workspace);
    const sessions = await sessionsWithRunIds(workspace);
    sendJson(response, 200, {
      workspace,
      currentSession: workspace === pi.workspace ? pi.currentSessionPath : null,
      sessions,
      runtimes,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/session/rename') {
    const body = await readJson(request);
    const workspace = await resolveWorkspace(body.cwd);
    const session = await findSession(workspace, body.path);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
      throw new RequestError('session name must be between 1 and 100 characters');
    }
    await mutateSession(session, async (current) => {
      const runtime = [...piSessions.values()].find((entry) => entry.pi.currentSessionPath === current.path);
      if (runtime) {
        await runtime.pi.setSessionName(body.name.trim());
        runtime.lastUsed = Date.now();
        return;
      }

      const temporaryPi = new PiSession({ cwd: workspace, command: piCommand });
      try {
        await temporaryPi.switchSession(current.path, workspace);
        await temporaryPi.setSessionName(body.name.trim());
      } finally {
        await temporaryPi.stop();
      }
    });
    sendJson(response, 200, { ok: true, name: body.name.trim() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/session/delete') {
    const body = await readJson(request);
    const workspace = await resolveWorkspace(body.cwd);
    const session = await findSession(workspace, body.path);
    const viewerId = viewerIdFor(request);
    const requesterRuntimeId = clientIdFor(request);
    const runtimeId = await mutateSession(session, async (current) => {
      const targetRuntimes = [...piSessions.entries()].filter(([, entry]) => entry.pi.currentSessionPath === current.path);

      for (const [targetRuntimeId, entry] of targetRuntimes) {
        if (entry.pi.hasActiveWork) {
          throw new RequestError('Cannot delete a session while it is working or opening', 409);
        }
        if (runtimeHasOtherViewers(targetRuntimeId, viewerId)) {
          throw new RequestError('Cannot delete a session that is open on another device', 409);
        }
      }

      const replaceRuntime = targetRuntimes.some(([targetRuntimeId]) => targetRuntimeId === requesterRuntimeId);
      for (const [targetRuntimeId, entry] of targetRuntimes) {
        await retireRuntime(targetRuntimeId, entry);
      }
      await unlink(current.path);

      if (!replaceRuntime) return requesterRuntimeId;
      const replacementRuntimeId = randomUUID();
      createPiRuntime(replacementRuntimeId, workspace);
      return replacementRuntimeId;
    });
    sendJson(response, 200, { ok: true, runtimeId, workspace });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/history') {
    let limit = null;
    if (url.searchParams.has('limit')) {
      const rawLimit = url.searchParams.get('limit');
      const parsedLimit = Number.parseInt(rawLimit, 10);
      if (!/^\d+$/.test(rawLimit) || parsedLimit < 1 || parsedLimit > 100) {
        throw new RequestError('history limit must be between 1 and 100');
      }
      limit = parsedLimit;
    }
    const history = await pi.history();
    sendJson(response, 200, {
      messages: limit ? history.slice(-limit) : history,
      total: history.length,
      workspace: pi.workspace,
      sessionPath: pi.currentSessionPath,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/chat') {
    const body = await readJson(request);
    if (typeof body.message !== 'string' || !body.message.trim()) {
      throw new RequestError('message is required');
    }
    if (body.message.length > 20_000) {
      throw new RequestError('message is too long');
    }
    if (pi.currentSessionPath) {
      let run = (await piRunRegistry.listRuns()).find((candidate) => candidate.sessionPath === pi.currentSessionPath);
      if (!run) {
        const session = (await listSessions(pi.workspace)).find((candidate) => candidate.path === pi.currentSessionPath);
        if (session) {
          const runId = await piRunRegistry.ensureRun({ workspace: pi.workspace, sessionPath: session.path, sessionId: session.id, name: session.name });
          run = await piRunRegistry.getRun(runId);
        }
      }
      if (run) assertPiRunAcceptsPrompt(await resolveSelectedPiRun({ runId: run.id, runRegistry: piRunRegistry }));
    }

    const reply = await pi.chat(body.message.trim());
    sendJson(response, 200, { role: 'assistant', content: reply });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/abort') {
    if (!pi.canAbort) throw new RequestError('Pi is not currently responding', 409);
    sendJson(response, 200, { aborted: await pi.abort() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/session/reset') {
    const body = await readJson(request);
    const workspace = body.cwd === undefined ? pi.workspace : await resolveWorkspace(body.cwd);
    const runtimeId = randomUUID();
    const resetPi = createPiRuntime(runtimeId, workspace);
    await resetPi.persistCurrentSession();
    const session = await findSession(workspace, resetPi.currentSessionPath);
    const runId = await piRunRegistry.ensureRun({ workspace, sessionPath: session.path, sessionId: session.id, name: session.name });
    await persistWorkspace(workspace);
    sendJson(response, 200, {
      ok: true,
      runtimeId,
      runId,
      workspace: resetPi.workspace,
      sessionPath: resetPi.currentSessionPath,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/session/select') {
    const body = await readJson(request);
    const workspace = await resolveWorkspace(body.cwd);
    const sessions = await listSessions(workspace);
    const selected = sessions.find((session) => session.path === body.path);
    if (!selected) {
      throw new RequestError('session was not found in the selected workspace');
    }
    if (sessionMutations.has(selected.path)) throw new RequestError('This session is already being changed', 409);
    sessionMutations.add(selected.path);
    try {
      const runId = await piRunRegistry.ensureRun({ workspace, sessionPath: selected.path, sessionId: selected.id, name: selected.name });

      const attachedRuntime = runtimeForSessionPath(workspace, selected.path);
      let selectedPi = attachedRuntime?.pi || pi;
      let runtimeId = attachedRuntime?.runtimeId || clientIdFor(request);
      const sharedRuntime = runtimeHasOtherViewers(runtimeId, viewerIdFor(request));
      const changingSharedSession = sharedRuntime && pi.currentSessionPath !== selected.path;
      if (!attachedRuntime && (pi.isBusy || changingSharedSession)) {
        runtimeId = randomUUID();
        selectedPi = createPiRuntime(runtimeId, workspace);
      }

      if (selectedPi.currentSessionPath !== selected.path || selectedPi.workspace !== workspace) {
        await selectedPi.switchSession(selected.path, workspace);
      }
      await persistWorkspace(workspace);
      sendJson(response, 200, {
        ok: true,
        runtimeId,
        runId,
        workspace: selectedPi.workspace,
        sessionPath: selectedPi.currentSessionPath,
      });
      return;
    } finally {
      sessionMutations.delete(selected.path);
    }
  }

  sendJson(response, 404, { error: 'Not found' });
}

const server = createServer((request, response) => {
  handleRequest(request, response)
    .catch((error) => {
      const missingPi = error.code === 'ENOENT' && error.path === piCommand;
      const status = missingPi ? 404 : error.status || (error.message.includes('already responding') ? 409 : 500);
      if (!response.headersSent) {
        if (Number.isFinite(error.retryAfter)) response.setHeader('Retry-After', String(error.retryAfter));
        sendJson(response, status, { error: missingPi ? 'Pi is not installed. Install the Pi CLI from https://pi.dev and ensure pi is on PATH, or set PI_COMMAND.' : error.message });
      } else {
        response.destroy(error);
      }
    })
    .finally(() => releasePiRequest(request));
});

server.requestTimeout = 30_000;

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function cpuSnapshot() {
  return cpus().map(({ times }) => ({
    idle: times.idle,
    total: Object.values(times).reduce((sum, value) => sum + value, 0),
  }));
}

async function getSystemUsage() {
  const before = cpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = cpuSnapshot();
  let idleDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    idleDelta += after[index].idle - before[index].idle;
    totalDelta += after[index].total - before[index].total;
  }
  const memoryTotal = totalmem();
  const memoryUsed = memoryTotal - freemem();
  const [load1] = loadavg();
  return {
    memoryUsed,
    memoryTotal,
    memoryPercent: (memoryUsed / memoryTotal) * 100,
    cpuPercent: totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0,
    cpuCores: after.length,
    load1,
  };
}

async function logSystemUsage() {
  const usage = await getSystemUsage();
  console.log(`device usage: memory ${formatBytes(usage.memoryUsed)} / ${formatBytes(usage.memoryTotal)} (${usage.memoryPercent.toFixed(1)}%); cpu ${usage.cpuPercent.toFixed(1)}% across ${usage.cpuCores} cores (load ${usage.load1.toFixed(2)})`);
}

let usageTimer;
let githubSyncTimer;
let restartScheduled = false;

const startServer = async () => {
  await migrateStorage();
  await mkdir(dirname(agentDir), { recursive: true, mode: 0o700 });
  await loadPersistedWorkspace();
  await logSystemUsage();
  server.listen(port, host, () => {
    console.log(`friday listening on http://${host}:${port}`);
    console.log(`pi workspace: ${initialWorkspace}`);
    console.log(`workspace roots: ${workspaceRoots.join(', ')}`);
  });
  usageTimer = setInterval(() => void logSystemUsage(), 60_000);
  scheduleGitHubSyncs();
  void runScheduledSyncs().catch((error) => console.error(`startup GitHub sync failed: ${error.message}`));
};

void startServer();

let shuttingDown = false;
const shutdown = async (signal, forceConnections = false) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  if (usageTimer) clearInterval(usageTimer);
  if (githubSyncTimer) clearTimeout(githubSyncTimer);
  clearInterval(runtimeCleanupTimer);

  const serverClosed = new Promise((resolve) => server.close(resolve));
  if (forceConnections) server.closeAllConnections?.();
  await serverClosed;
  await Promise.allSettled(Object.values(syncState).map(({ promise }) => promise).filter(Boolean));
  if (fridayInit) await fridayInit.catch(() => {});
  await Promise.all([
    ...[...piSessions.values()].map(({ pi }) => pi.stop()),
    fridayPi?.stop(),
  ]);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
