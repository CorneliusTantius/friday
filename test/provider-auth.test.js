import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderAuth } from '../src/integrations/provider-auth.js';

test('uses explicit per-agent paths and exposes only non-secret credential status', async () => {
  let paths; let loginArgs;
  const service = new ProviderAuth({ agentDir: '/tmp/provider-agent', createModelRuntime: async (options) => {
    paths = options;
    return { getProviderAuthStatus: () => ({ status: 'authenticated', token: 'secret' }), hasConfiguredAuth: () => true,
      login: async (...args) => { loginArgs = args; } };
  } });
  assert.deepEqual(await service.status('example'), { providerId: 'example', configured: true, status: 'authenticated' });
  assert.equal(paths.authPath, '/tmp/provider-agent/auth.json');
  assert.equal(paths.modelsPath, '/tmp/provider-agent/models.json');
  await service.loginApiKey('example', 'secret-key');
  assert.equal(loginArgs[0], 'example');
  assert.equal(loginArgs[1], 'api_key');
  assert.equal(await loginArgs[2].prompt(), 'secret-key');
  assert.deepEqual(await service.status('example'), { providerId: 'example', configured: true, status: 'authenticated' });
});

test('OAuth challenges publish redacted steps, expire, and cancel', async () => {
  const service = new ProviderAuth({ agentDir: '/tmp/provider-agent-oauth', challengeTtlMs: 10_000,
    createModelRuntime: async () => ({ login: async (_provider, _type, interaction) => {
      assert.ok(interaction.signal instanceof AbortSignal);
      interaction.notify('https://example.test/login');
      const answer = await interaction.prompt({ message: 'Code', secret: 'never expose' });
      assert.equal(answer, 'user-code');
      await new Promise((resolve) => interaction.signal.addEventListener('abort', resolve, { once: true }));
    } }) });
  const challenge = await service.beginOAuth('example');
  assert.deepEqual(await service.next(challenge.id), { ok: true, step: { type: 'info', message: 'https://example.test/login' } });
  assert.deepEqual(await service.next(challenge.id), { ok: true, step: { type: 'prompt', requiresResponse: true, message: 'Code' } });
  assert.deepEqual(await service.answer(challenge.id, 'user-code'), { ok: true });
  assert.equal(service.cancel(challenge.id), true);
  assert.deepEqual(await service.next(challenge.id), { ok: false, error: 'Challenge unavailable' });
});

test('OAuth handles Codex auth_url, device_code, manual_code, completion and redacts secrets', async () => {
  let complete;
  const service = new ProviderAuth({ agentDir: '/tmp/provider-agent-codex', createModelRuntime: async () => ({
    login: async (_provider, _method, { notify, prompt }) => {
      notify({ type: 'auth_url', url: 'https://auth.openai.com/authorize', instructions: 'Open link', access_token: 'do-not-leak' });
      notify({ type: 'device_code', verificationUri: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH', secret: 'hidden' });
      assert.equal(await prompt({ type: 'manual_code', message: 'Paste code', placeholder: 'Code', secret: 'hidden' }), 'returned-code');
      await new Promise((resolve) => { complete = resolve; });
    },
  }) });
  const { id } = await service.beginOAuth('openai-codex');
  assert.deepEqual((await service.next(id)).step, { type: 'auth_url', url: 'https://auth.openai.com/authorize', instructions: 'Open link' });
  assert.deepEqual((await service.next(id)).step, { type: 'device_code', verificationUri: 'https://auth.openai.com/device', userCode: 'ABCD-EFGH' });
  assert.deepEqual((await service.next(id)).step, { type: 'manual_code', requiresResponse: true, message: 'Paste code', placeholder: 'Code' });
  assert.deepEqual(await service.answer(id, 'returned-code'), { ok: true });
  complete();
  assert.deepEqual(await service.next(id), { ok: true });
  assert.equal(service.challenges.has(id), false);
});

test('OAuth pending poll, timeout and cancellation settle without exposing SDK errors', async () => {
  const service = new ProviderAuth({ agentDir: '/tmp/provider-agent-timeout', challengeTtlMs: 80, createModelRuntime: async () => ({ login: async () => new Promise(() => {}) }) });
  const { id } = await service.beginOAuth('openai-codex');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await service.next(id), { ok: false, error: 'Challenge unavailable' });
});

test('real SDK persists OpenAI API keys in separate private Friday and Pi stores', async (t) => {
  const { mkdtemp, readFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'friday-provider-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const friday = new ProviderAuth({ agentDir: join(root, '.friday', 'config') });
  const pi = new ProviderAuth({ agentDir: join(root, '.pi', 'agent') });
  await friday.loginApiKey('openai', 'friday-test-secret');
  const fridayFile = join(root, '.friday', 'config', 'auth.json');
  const piFile = join(root, '.pi', 'agent', 'auth.json');
  assert.match(await readFile(fridayFile, 'utf8'), /friday-test-secret/);
  assert.equal((await stat(fridayFile)).mode & 0o077, 0);
  await assert.rejects(readFile(piFile), { code: 'ENOENT' });
  await pi.loginApiKey('openai', 'pi-test-secret');
  assert.doesNotMatch(await readFile(piFile, 'utf8'), /friday-test-secret/);
  assert.doesNotMatch(await readFile(fridayFile, 'utf8'), /pi-test-secret/);
  assert.equal((await stat(piFile)).mode & 0o077, 0);
});
