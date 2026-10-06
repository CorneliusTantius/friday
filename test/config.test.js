import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, migrateStorage } from '../src/config.js';

test('Pi workspace defaults to Friday workspace independently of Pi state paths', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-default-workspace-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = join(home, '.friday', 'workspace');
  assert.equal((await loadConfig({ home, env: {} })).workspace, workspace);
  assert.equal((await loadConfig({ home, env: { PI_CODING_AGENT_DIR: join(home, 'custom', 'agent') } })).workspace, workspace);
  assert.equal((await loadConfig({ home, env: { FRIDAY_HOME: join(home, 'custom-friday') } })).workspace, join(home, 'custom-friday', 'workspace'));
});

test('config precedence is defaults, JSON, then environment', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configFile = join(home, '.friday/config/config.json');
  await mkdir(join(home, '.friday/config'), { recursive: true });
  await writeFile(configFile, JSON.stringify({ workspace: '/from-json', custom: true }));
  assert.deepEqual(await loadConfig({ home, env: { FRIDAY_CONFIG_FILE: configFile, FRIDAY_WORKSPACE: '/from-env' } }), {
    workspace: '/from-env', custom: true,
  });
});

test('invalid config and credential fields are rejected', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-invalid-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configFile = join(home, 'config.json');
  await writeFile(configFile, JSON.stringify({ workspace: 42 }));
  await assert.rejects(loadConfig({ home, env: { FRIDAY_CONFIG_FILE: configFile } }), /workspace/);
  await writeFile(configFile, JSON.stringify({ apiKey: 'private' }));
  await assert.rejects(loadConfig({ home, env: { FRIDAY_CONFIG_FILE: configFile } }), /credentials/);
});

test('migration preserves legacy settings and session contents', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-migrate-'));
  const cwd = join(home, 'old-workspace');
  t.after(() => rm(home, { recursive: true, force: true }));
  const oldSettings = join(home, '.pi/agent/friday-settings.json');
  const oldSessions = join(cwd, 'sessions');
  const oldNotes = join(home, '.friday/notes');
  const oldRepos = join(home, '.friday/repos/project');
  await mkdir(oldSessions, { recursive: true });
  await mkdir(oldNotes, { recursive: true });
  await mkdir(oldRepos, { recursive: true });
  await writeFile(join(oldNotes, 'keep.md'), 'Friday note');
  await writeFile(join(oldRepos, 'README.md'), 'repository');
  await mkdir(join(home, '.pi/agent'), { recursive: true });
  await writeFile(oldSettings, JSON.stringify({ workspace: cwd }));
  const transcript = '{"type":"session","id":"preserved"}\n';
  await writeFile(join(oldSessions, 'chat.jsonl'), transcript);
  const paths = await migrateStorage({ home, env: { FRIDAY_CHAT_DIR: cwd } });
  assert.equal(paths.notesDir, join(home, '.friday', 'workspace', 'notes'));
  assert.equal(paths.reposDir, join(home, '.friday', 'workspace', 'repos'));
  assert.equal(await readFile(join(paths.notesDir, 'keep.md'), 'utf8'), 'Friday note');
  assert.equal(await readFile(join(paths.reposDir, 'project', 'README.md'), 'utf8'), 'repository');
  await assert.rejects(readdir(join(home, '.friday', 'notes')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(paths.configDir, 'config.json'), 'utf8')).workspace, cwd);
  assert.equal(await readFile(oldSettings, 'utf8'), JSON.stringify({ workspace: cwd }));
  assert.equal(await readFile(join(paths.dataDir, 'chat.jsonl'), 'utf8'), transcript);
});

test('migration copies a legacy single-file transcript without overwriting', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'friday-single-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const transcriptPath = join(home, 'old-chat.jsonl');
  const transcript = '{"type":"session","id":"single"}\\n';
  await writeFile(transcriptPath, transcript);
  const paths = await migrateStorage({ home, env: { FRIDAY_CHAT_DIR: transcriptPath } });
  assert.equal(await readFile(join(paths.dataDir, 'old-chat.jsonl'), 'utf8'), transcript);
});
