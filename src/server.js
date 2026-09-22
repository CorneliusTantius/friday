import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpus, freemem, homedir, hostname, loadavg, platform, totalmem } from 'node:os';
import { createInterface } from 'node:readline';
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PiSession } from './pi-session.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const workspaceRoots = [resolve(homedir())];
let initialWorkspace = resolve(homedir());
let preferredWorkspace = initialWorkspace;
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
const settingsFile = resolve(process.env.FRIDAY_SETTINGS_FILE || join(agentDir, 'friday-settings.json'));
const sessionStorage = resolve(process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir, 'sessions'));
const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const piSessions = new Map();
const execFileAsync = promisify(execFile);
const piCommand = process.env.PI_COMMAND || 'pi';
const maxPiSessions = 32;
const maxFileEntries = 500;
const maxFilePreviewBytes = 1_000_000;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function clientIdFor(request) {
  const value = request.headers['x-friday-session'];
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : 'default';
}

function createPiRuntime(runtimeId, cwd = preferredWorkspace) {
  if (piSessions.size >= maxPiSessions) {
    const idle = [...piSessions.entries()]
      .filter(([, candidate]) => !candidate.pi.isBusy)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
    if (!idle) {
      throw new RequestError('Too many active Pi sessions', 429);
    }
    piSessions.delete(idle[0]);
    void idle[1].pi.stop();
  }

  const entry = {
    pi: new PiSession({ cwd, command: piCommand }),
    lastUsed: Date.now(),
  };
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
  return entry.pi;
}

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

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) {
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
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
    const workspace = await resolveWorkspace(settings.workspace);
    initialWorkspace = workspace;
    preferredWorkspace = workspace;
  } catch {
    // Missing or stale settings should fall back to the configured default root.
  }
}

async function persistWorkspace(workspace) {
  await mkdir(dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify({ workspace }, null, 2)}\n`, 'utf8');
  preferredWorkspace = workspace;
}

async function configuredWorkspaceRoot(workspace) {
  const roots = await allowedRootPaths();
  const root = roots
    .filter((candidate) => isWithin(candidate, workspace))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) {
    throw new RequestError('workspace is outside the configured workspace roots');
  }
  return root;
}

async function resolveConfiguredRoot(path) {
  const candidate = await resolveWorkspace(path);
  const roots = await allowedRootPaths();
  if (!roots.includes(candidate)) {
    throw new RequestError('file root must be a configured workspace root');
  }
  return candidate;
}

async function resolveWorkspaceEntry(cwd, inputPath = '') {
  const workspace = await resolveWorkspace(cwd);
  if (typeof inputPath !== 'string' || inputPath.includes('\0') || isAbsolute(inputPath)) {
    throw new RequestError('file path must be relative to the workspace');
  }

  const candidate = resolve(workspace, inputPath || '.');
  if (!isWithin(workspace, candidate)) {
    throw new RequestError('file path is outside the workspace');
  }

  let info;
  try {
    info = await lstat(candidate);
  } catch {
    throw new RequestError('file or directory was not found', 404);
  }
  if (info.isSymbolicLink()) {
    throw new RequestError('symbolic links are not available in Files', 403);
  }

  const realPath = await realpath(candidate);
  if (!isWithin(workspace, realPath)) {
    throw new RequestError('file path is outside the workspace');
  }

  return {
    workspace,
    path: realPath,
    relativePath: relative(workspace, realPath).split(sep).join('/'),
    info,
  };
}

async function resolveFileContext(cwd, rootInput, inputPath, pathProvided) {
  const workspace = await resolveWorkspace(cwd);
  const root = rootInput ? await resolveConfiguredRoot(rootInput) : await configuredWorkspaceRoot(workspace);
  if (!isWithin(root, workspace)) {
    throw new RequestError('file root does not contain the workspace');
  }

  const initialPath = relative(root, workspace).split(sep).join('/');
  const targetPath = pathProvided ? inputPath : initialPath;
  const entry = await resolveWorkspaceEntry(root, targetPath);
  return { workspace, root, entry };
}

async function listWorkspaceFiles(cwd, rootInput, inputPath, pathProvided) {
  const context = await resolveFileContext(cwd, rootInput, inputPath, pathProvided);
  const directory = context.entry;
  if (!directory.info.isDirectory()) {
    throw new RequestError('file path is not a directory', 400);
  }

  let names;
  try {
    names = await readdir(directory.path, { withFileTypes: true });
  } catch {
    throw new RequestError('directory could not be read', 403);
  }
  if (names.length > maxFileEntries) {
    throw new RequestError(`directory contains more than ${maxFileEntries} entries`, 413);
  }

  const entries = [];
  for (const entry of names) {
    const childPath = join(directory.path, entry.name);
    let info;
    try {
      info = await lstat(childPath);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      continue;
    }
    const childRelativePath = `${directory.relativePath ? `${directory.relativePath}/` : ''}${entry.name}`;
    entries.push({
      name: entry.name,
      path: childRelativePath,
      workspacePath: isWithin(context.workspace, childPath)
        ? relative(context.workspace, childPath).split(sep).join('/')
        : null,
      type: info.isDirectory() ? 'directory' : 'file',
      size: info.isFile() ? info.size : null,
      modified: info.mtime.toISOString(),
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    workspace: context.workspace,
    root: directory.workspace,
    path: directory.relativePath,
    entries,
  };
}

async function readWorkspaceFile(cwd, rootInput, inputPath) {
  const context = await resolveFileContext(cwd, rootInput, inputPath, true);
  const file = context.entry;
  if (!file.info.isFile()) {
    throw new RequestError('file path is not a regular file', 400);
  }
  if (file.info.size > maxFilePreviewBytes) {
    throw new RequestError(`file is larger than ${maxFilePreviewBytes} bytes`, 413);
  }

  const content = await readFile(file.path);
  if (content.includes(0)) {
    throw new RequestError('binary files cannot be previewed', 415);
  }
  return {
    workspace: context.workspace,
    root: file.workspace,
    path: file.relativePath,
    workspacePath: isWithin(context.workspace, file.path)
      ? relative(context.workspace, file.path).split(sep).join('/')
      : null,
    size: content.length,
    modified: file.info.mtime.toISOString(),
    content: content.toString('utf8'),
  };
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

function sessionDirectoryFor(cwd) {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    return sessionStorage;
  }

  const safePath = resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return join(sessionStorage, `--${safePath}--`);
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

async function readSessionMetadata(path, workspace) {
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

  if (!header || resolve(header.cwd) !== resolve(workspace)) {
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

async function listSessions(workspace) {
  const directory = sessionDirectoryFor(workspace);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => readSessionMetadata(join(directory, entry.name), workspace)),
  );

  return sessions
    .filter(Boolean)
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

async function serveStatic(pathname, response) {
  const filenames = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css',
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

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const { pathname } = url;
  const pi = piForRequest(request);

  if (request.method === 'GET' && pathname === '/healthz') {
    sendJson(response, 200, {
      status: 'ok',
      piRunning: pi.isRunning,
      workspace: pi.workspace,
      sessionPath: pi.currentSessionPath,
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/status') {
    sendJson(response, 200, {
      workspace: pi.workspace,
      preferredWorkspace,
      sessionPath: pi.currentSessionPath,
      model: modelForClient(pi.currentModel),
      thinkingLevel: pi.currentThinkingLevel,
      piRunning: pi.isRunning,
      busy: pi.isBusy,
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

  if (request.method === 'GET' && pathname === '/api/files') {
    sendJson(response, 200, await listWorkspaceFiles(
      url.searchParams.get('cwd') || pi.workspace,
      url.searchParams.get('root') || '',
      url.searchParams.get('path') || '',
      url.searchParams.has('path'),
    ));
    return;
  }

  if (request.method === 'GET' && pathname === '/api/files/content') {
    const path = url.searchParams.get('path');
    if (!path) throw new RequestError('file path is required');
    sendJson(response, 200, await readWorkspaceFile(
      url.searchParams.get('cwd') || pi.workspace,
      url.searchParams.get('root') || '',
      path,
    ));
    return;
  }

  if (request.method === 'GET' && pathname === '/api/devices') {
    sendJson(response, 200, await listDevices());
    return;
  }

  if (request.method === 'GET' && pathname === '/api/settings') {
    sendJson(response, 200, {
      host,
      port,
      piCommand,
      workspaceRoots,
      workspace: pi.workspace,
      preferredWorkspace,
      sessionPath: pi.currentSessionPath,
      model: modelForClient(pi.currentModel),
      thinkingLevel: pi.currentThinkingLevel,
      systemUsage: await getSystemUsage(),
      piRunning: pi.isRunning,
      busy: pi.isBusy,
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/settings/workspace') {
    const body = await readJson(request);
    const workspace = await resolveWorkspace(body.workspace);
    if (pi.workspace !== workspace) {
      await pi.reset(workspace);
    }
    await persistWorkspace(workspace);
    sendJson(response, 200, { workspace, preferredWorkspace });
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
    const runtimeByPath = new Map(runtimes.map((runtime) => [runtime.sessionPath, runtime]));
    const sessions = (await listSessions(workspace)).map((session) => {
      const runtime = runtimeByPath.get(session.path);
      return {
        ...session,
        runtimeId: runtime?.runtimeId || null,
        running: runtime?.running || false,
        busy: runtime?.busy || false,
      };
    });
    sendJson(response, 200, {
      workspace,
      currentSession: workspace === pi.workspace ? pi.currentSessionPath : null,
      sessions,
      runtimes,
    });
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
    sendJson(response, 200, {
      messages: await pi.history(limit),
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

    const reply = await pi.chat(body.message.trim());
    sendJson(response, 200, { role: 'assistant', content: reply });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/session/reset') {
    const body = await readJson(request);
    const workspace = body.cwd === undefined ? pi.workspace : await resolveWorkspace(body.cwd);
    await pi.reset(workspace);
    await persistWorkspace(workspace);
    sendJson(response, 200, {
      ok: true,
      workspace: pi.workspace,
      sessionPath: pi.currentSessionPath,
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

    let selectedPi = pi;
    let runtimeId = clientIdFor(request);
    if (pi.isBusy) {
      runtimeId = randomUUID();
      selectedPi = createPiRuntime(runtimeId, workspace);
    }

    await selectedPi.switchSession(selected.path, workspace);
    await persistWorkspace(workspace);
    sendJson(response, 200, {
      ok: true,
      runtimeId,
      workspace: selectedPi.workspace,
      sessionPath: selectedPi.currentSessionPath,
    });
    return;
  }

  if (request.method === 'GET' && await serveStatic(pathname, response)) {
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = error.status || (error.message.includes('already responding') ? 409 : 500);
    if (!response.headersSent) {
      sendJson(response, status, { error: error.message });
    } else {
      response.destroy(error);
    }
  });
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

const startServer = async () => {
  await loadPersistedWorkspace();
  await logSystemUsage();
  server.listen(port, host, () => {
    console.log(`friday listening on http://${host}:${port}`);
    console.log(`pi workspace: ${initialWorkspace}`);
    console.log(`workspace roots: ${workspaceRoots.join(', ')}`);
  });
  usageTimer = setInterval(() => void logSystemUsage(), 60_000);
};

void startServer();

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  if (usageTimer) clearInterval(usageTimer);

  await new Promise((resolve) => server.close(resolve));
  await Promise.all([...piSessions.values()].map(({ pi }) => pi.stop()));
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
