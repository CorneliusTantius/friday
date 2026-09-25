import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, readdir, rename, rmdir, copyFile, stat, writeFile } from 'node:fs/promises';

function environmentConfig(env) {
  const overrides = {};
  if (env.FRIDAY_WORKSPACE) overrides.workspace = env.FRIDAY_WORKSPACE;
  return overrides;
}

export function fridayPaths(home = homedir(), env = process.env) {
  const root = resolve(env.FRIDAY_HOME || join(home, '.friday'));
  const workspaceDir = join(root, 'workspace');
  return {
    root,
    configDir: join(root, 'config'),
    configFile: resolve(env.FRIDAY_CONFIG_FILE || join(root, 'config', 'config.json')),
    dataDir: resolve(env.FRIDAY_DATA_DIR || join(root, 'data')),
    workspaceDir,
    reposDir: join(workspaceDir, 'repos'),
    notesDir: join(workspaceDir, 'notes'),
    legacyReposDir: join(root, 'repos'),
    legacyNotesDir: join(root, 'notes'),
    legacyConfigFile: resolve(env.FRIDAY_SETTINGS_FILE || join(home, '.pi', 'agent', 'friday-settings.json')),
    legacyChatDir: resolve(env.FRIDAY_CHAT_DIR || join(process.cwd(), 'memory')),
  };
}

function validateConfig(value, label = 'Config') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|credential|api.?key/i.test(key)) throw new Error(`${label} must not contain credentials`);
    if (key === 'workspace' && (typeof item !== 'string' || !item.trim())) throw new Error(`${label} workspace must be a non-empty string`);
    if (typeof item === 'function' || typeof item === 'undefined') throw new Error(`${label} contains an invalid value`);
  }
  return value;
}

export async function loadConfig({ home = homedir(), env = process.env, defaults } = {}) {
  const paths = fridayPaths(home, env);
  defaults ??= { workspace: resolve(join(env.PI_CODING_AGENT_DIR ? dirname(env.PI_CODING_AGENT_DIR) : join(home, '.pi'), 'workspace')) };
  let stored = {};
  try {
    stored = validateConfig(JSON.parse(await readFile(paths.configFile, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  validateConfig(defaults, 'Defaults');
  return { ...defaults, ...stored, ...environmentConfig(env) };
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

export async function migrateDirectory(source, destination) {
  const from = resolve(source);
  const to = resolve(destination);
  if (from === to) return;
  let sourceInfo;
  try { sourceInfo = await lstat(from); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`Migration source is not a real directory: ${from}`);
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  let destinationInfo;
  try { destinationInfo = await lstat(to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!destinationInfo) {
    await rename(from, to);
    return;
  }
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) throw new Error(`Migration destination is not a real directory: ${to}`);
  for (const entry of await readdir(from)) {
    const sourceEntry = join(from, entry);
    const destinationEntry = join(to, entry);
    let existing;
    try { existing = await lstat(destinationEntry); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      await rename(sourceEntry, destinationEntry);
    } else {
      const incoming = await lstat(sourceEntry);
      if (incoming.isDirectory() && !incoming.isSymbolicLink() && existing.isDirectory() && !existing.isSymbolicLink()) {
        await migrateDirectory(sourceEntry, destinationEntry);
      } else {
        throw new Error(`Migration conflict; both locations contain ${entry}: ${from} and ${to}`);
      }
    }
  }
  await rmdir(from);
}

export async function migrateStorage({ home = homedir(), env = process.env } = {}) {
  const paths = fridayPaths(home, env);
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.workspaceDir, { recursive: true, mode: 0o700 });
  await migrateDirectory(paths.legacyReposDir, paths.reposDir);
  await migrateDirectory(paths.legacyNotesDir, paths.notesDir);
  await mkdir(paths.reposDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.notesDir, { recursive: true, mode: 0o700 });

  // Preserve the legacy file; copy only its workspace when no new config exists.
  if (!(await exists(paths.configFile)) && await exists(paths.legacyConfigFile)) {
    try {
      const legacy = JSON.parse(await readFile(paths.legacyConfigFile, 'utf8'));
      validateConfig(legacy, 'Legacy config');
      if (typeof legacy.workspace === 'string') {
        await writeFile(paths.configFile, `${JSON.stringify({ workspace: legacy.workspace }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  // Copy session JSONL files into the flat Friday data directory without overwriting.
  async function copyTranscript(source, name) {
    if (!name.endsWith('.jsonl') || name !== name.split(/[\\/]/).pop()) return;
    const target = join(paths.dataDir, name);
    try { await copyFile(source, target, 1); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const legacySessions = join(paths.legacyChatDir, 'sessions');
  if (await exists(legacySessions)) {
    for (const entry of await readdir(legacySessions, { withFileTypes: true })) {
      if (entry.isFile()) await copyTranscript(join(legacySessions, entry.name), entry.name);
    }
  } else if (await exists(paths.legacyChatDir)) {
    const info = await stat(paths.legacyChatDir);
    if (info.isFile()) await copyTranscript(paths.legacyChatDir, paths.legacyChatDir.split(/[\\/]/).pop());
  }
  return paths;
}
