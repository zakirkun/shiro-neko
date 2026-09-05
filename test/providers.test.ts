import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, readConfigFile, writeConfigFile } from '../src/config';
import { fetchModels, presetById, PRESETS } from '../src/providers';

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['SHIRO_HOME', 'SHIRO_PROVIDER', 'SHIRO_MODEL', 'SHIRO_BASE_URL', 'SHIRO_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'shiro-cfg-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

test('every preset has a usable kind and a fetchable-looking base URL', () => {
  for (const p of PRESETS) {
    expect(['anthropic', 'openai']).toContain(p.kind);
    if (p.baseURL) expect(p.baseURL.startsWith('http')).toBe(true);
    expect(presetById(p.id)?.label).toBe(p.label);
  }
});

test('writeConfigFile persists what onboarding chose and loadConfig reads it back', async () => {
  await writeConfigFile({
    provider: 'openai',
    model: 'llama-3.3-70b',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: 'gsk_test',
    presetId: 'groq',
  });

  const cfg = await loadConfig();
  expect(cfg.provider).toBe('openai');
  expect(cfg.model).toBe('llama-3.3-70b');
  expect(cfg.baseURL).toBe('https://api.groq.com/openai/v1');
  expect(cfg.apiKey).toBe('gsk_test');
  expect(cfg.presetId).toBe('groq');
});

test('writeConfigFile merges instead of clobbering unrelated keys', async () => {
  await writeConfigFile({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server'] } } });
  await writeConfigFile({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-1' });

  const file = await readConfigFile();
  expect(file.mcpServers?.['fs']).toEqual({ command: 'npx', args: ['-y', 'server'] });
  expect(file.model).toBe('gpt-5');
});

/**
 * What `/mcp add` and `/mcp remove` do to the file, exercised through the real
 * persistence path. The hooks themselves live inline in cli.tsx, which a test
 * cannot import — this covers the primitive they are built on.
 */
test('an mcp server survives a round trip through the config file, and removal takes it out', async () => {
  await writeConfigFile({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-1' });

  const local = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] };
  const remote = { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer sk-x' } };
  await writeConfigFile({ mcpServers: { filesystem: local, api: remote } });

  const loaded = await loadConfig();
  expect(loaded.mcpServers?.['filesystem']).toEqual(local);
  expect(loaded.mcpServers?.['api']).toEqual(remote);
  // Adding a server must not disturb the provider settings beside it.
  expect(loaded.apiKey).toBe('sk-1');

  const { filesystem: _removed, ...rest } = (await readConfigFile()).mcpServers!;
  await writeConfigFile({ mcpServers: rest });

  const after = await loadConfig();
  expect(Object.keys(after.mcpServers ?? {})).toEqual(['api']);
  expect(after.apiKey).toBe('sk-1');
});

test('env still overrides the saved config', async () => {
  await writeConfigFile({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-file' });
  process.env['SHIRO_MODEL'] = 'gpt-5-mini';
  process.env['SHIRO_API_KEY'] = 'sk-env';

  const cfg = await loadConfig();
  expect(cfg.model).toBe('gpt-5-mini');
  expect(cfg.apiKey).toBe('sk-env');
});

test('a fresh install reports no api key so the TUI can open onboarding', async () => {
  expect((await loadConfig()).apiKey).toBeUndefined();
});

test('fetchModels reads data[].id from an OpenAI-shaped response and sends a bearer token', async () => {
  const captured: Record<string, string | null> = {};
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      captured['auth'] = req.headers.get('authorization');
      return Response.json({ data: [{ id: 'gpt-5' }, { id: 'gpt-4o' }] });
    },
  });

  const res = await fetchModels({ kind: 'openai', baseURL: `http://127.0.0.1:${server.port}/v1` }, 'sk-abc');
  server.stop(true);

  expect(res.source).toBe('api');
  expect(res.models).toEqual(['gpt-4o', 'gpt-5']);
  expect(captured['auth']).toBe('Bearer sk-abc');
});

test('fetchModels uses anthropic auth headers for the anthropic wire format', async () => {
  const h: Record<string, string | null> = {};
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      h['key'] = req.headers.get('x-api-key');
      h['version'] = req.headers.get('anthropic-version');
      return Response.json({ data: [{ id: 'claude-sonnet-4-5' }] });
    },
  });

  const res = await fetchModels({ kind: 'anthropic', baseURL: `http://127.0.0.1:${server.port}/v1` }, 'sk-ant-1');
  server.stop(true);

  expect(res.models).toEqual(['claude-sonnet-4-5']);
  expect(h['key']).toBe('sk-ant-1');
  expect(h['version']).toBe('2023-06-01');
});

test('a rejected key falls back to the preset list and reports why', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('invalid api key', { status: 401 }),
  });

  const res = await fetchModels(
    { kind: 'openai', baseURL: `http://127.0.0.1:${server.port}/v1`, fallbackModels: ['gpt-5'] },
    'sk-bad',
  );
  server.stop(true);

  expect(res.source).toBe('fallback');
  expect(res.models).toEqual(['gpt-5']);
  expect(res.warning).toContain('401');
  expect(res.warning).toContain('invalid api key');
});

test('an unreachable endpoint degrades instead of throwing', async () => {
  const res = await fetchModels({ kind: 'openai', baseURL: 'http://127.0.0.1:1/v1' }, 'sk-x', 2000);
  expect(res.source).toBe('fallback');
  expect(res.models).toEqual([]);
  expect(res.warning).toBeTruthy();
});

test('a server that lists nothing is treated as a failure to list', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [] }) });
  const res = await fetchModels({ kind: 'openai', baseURL: `http://127.0.0.1:${server.port}/v1` }, 'sk-x');
  server.stop(true);
  expect(res.source).toBe('fallback');
  expect(res.warning).toContain('listed no models');
});
