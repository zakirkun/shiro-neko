import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/plugins';
import { BUILTIN_PLUGINS, DEFAULT_ENABLED, formatPlugin, protectPlugin, secretsPlugin } from '../src/plugins-builtin';

const cwd = process.cwd();
const check = (toolName: string, input: unknown) => secretsPlugin.beforeToolCall!({ toolName, input, cwd });
const guarded = (toolName: string, input: unknown) => protectPlugin.beforeToolCall!({ toolName, input, cwd });

test('secrets is on by default, because an opt-in safety check is not one', () => {
  expect(DEFAULT_ENABLED).toContain('secrets');
  expect(DEFAULT_ENABLED).toContain('guard');
  expect(DEFAULT_ENABLED).toContain('protect');
  // Both of these act on their own rather than refusing, so they are opt-in.
  expect(DEFAULT_ENABLED).not.toContain('bell');
  expect(DEFAULT_ENABLED).not.toContain('format');
});

test('every builtin plugin has a unique name and a description', () => {
  const names = BUILTIN_PLUGINS.map((p) => p.name);
  expect(new Set(names).size).toBe(names.length);
  for (const p of BUILTIN_PLUGINS) expect(p.description.length, p.name).toBeGreaterThan(5);
});

test('writing an env file is refused', async () => {
  for (const path of ['.env', 'config/.env', 'app/.env.production', '.env.local']) {
    expect(await check('write_file', { path }), path).toContain('refusing to write');
  }
});

test('writing a key or certificate is refused', async () => {
  for (const path of ['certs/server.pem', 'app.key', 'store.p12', 'keys/id_rsa', '.ssh/id_ed25519']) {
    expect(await check('write_file', { path }), path).toContain('refusing to write');
  }
});

test('writing a registry or credential file is refused', async () => {
  for (const path of ['.npmrc', '.netrc', 'credentials.json', 'secrets.yaml', '.aws/config']) {
    expect(await check('write_file', { path }), path).toContain('refusing to write');
  }
});

test('every write tool is covered, including apply_patch', async () => {
  for (const tool of ['write_file', 'edit_file', 'multi_edit', 'delete_file']) {
    expect(await check(tool, { path: '.env' }), tool).toContain('refusing to write');
  }

  // A patch carries its paths in markers, so a guard that only reads `path` is
  // bypassed by the one tool that can touch several files at once.
  const patch = '*** Update File: src/app.ts\n-a\n+b\n*** Add File: .env\n+SECRET=x';
  expect(await check('apply_patch', { patch })).toContain('refusing to write');
  expect(await check('apply_patch', { patch: '*** Move to: .env.production\n' })).toContain('refusing to write');

  // A move carries two paths and neither is called `path`.
  expect(await check('move_file', { from: 'src/app.ts', to: '.env' })).toContain('refusing to write');
  expect(await check('move_file', { from: '.env', to: 'src/app.ts' })).toContain('refusing to write');
});

test('protect refuses git internals, lockfiles, dependencies, and build output', async () => {
  for (const path of [
    '.git/config',
    '.git/hooks/pre-commit',
    'bun.lock',
    'package-lock.json',
    'Cargo.lock',
    'go.sum',
    'node_modules/react/index.js',
    'vendor/github.com/pkg/errors.go',
    'dist/bundle.js',
    'coverage/lcov.info',
    '.next/build-manifest.json',
  ]) {
    expect(await guarded('write_file', { path }), path).toContain('refusing to write');
  }
});

test('protect covers every write tool and both ends of a move', async () => {
  for (const tool of ['write_file', 'edit_file', 'multi_edit', 'delete_file']) {
    expect(await guarded(tool, { path: 'bun.lock' }), tool).toContain('refusing to write');
  }
  expect(await guarded('apply_patch', { patch: '*** Update File: bun.lock\n-a\n+b' })).toContain('refusing to write');
  expect(await guarded('move_file', { from: 'src/a.ts', to: 'node_modules/a.ts' })).toContain('refusing to write');
});

test('protect matches a Windows path separator as well', async () => {
  expect(await guarded('write_file', { path: 'node_modules\\react\\index.js' })).toContain('refusing to write');
  expect(await guarded('write_file', { path: '.git\\config' })).toContain('refusing to write');
});

test('protect leaves ordinary files and lookalike names alone', async () => {
  for (const path of [
    'src/app.ts',
    'docs/dist-layout.md',
    'src/gitignore-parser.ts',
    'test/node_modules-resolution.test.ts',
    'package.json',
    'distributed/queue.ts',
  ]) {
    expect(await guarded('write_file', { path }), path).toBeUndefined();
  }
});

test('protect says what to do instead of editing the file', async () => {
  expect(protectPlugin.appendix).toContain('package manager');
  expect(String(await guarded('write_file', { path: 'bun.lock' }))).toContain('Regenerate it');
});

test('ordinary source files are untouched', async () => {
  for (const path of ['src/app.ts', 'README.md', 'docs/env-vars.md', 'test/environment.test.ts', 'keychain.ts']) {
    expect(await check('write_file', { path }), path).toBeUndefined();
  }
});

test('an example env file may be written, since it holds no secret', async () => {
  // The permission defaults allow *reading* .env.example for the same reason.
  expect(await check('write_file', { path: '.env.example' })).toBeUndefined();
});

test('reading is not the secrets plugin′s business', async () => {
  // Reads are refused by the permission defaults instead, so this must not also
  // block them: two mechanisms refusing the same thing means one is dead code.
  expect(await check('read_file', { path: '.env' })).toBeUndefined();
  expect(await check('bash', { command: 'cat .env' })).toBeUndefined();
});

test('the appendix tells the model what to do instead', () => {
  expect(secretsPlugin.appendix).toContain('let them write it');
});

test('the guard and secrets both run, and the first refusal wins', async () => {
  const host = createHost(BUILTIN_PLUGINS.filter((p) => DEFAULT_ENABLED.includes(p.name)));

  expect(await host.guard({ toolName: 'bash', input: { command: 'rm -rf /' }, cwd })).toContain('guard plugin');
  expect(await host.guard({ toolName: 'write_file', input: { path: '.env' }, cwd })).toContain('secrets plugin');
  expect(await host.guard({ toolName: 'write_file', input: { path: 'src/app.ts' }, cwd })).toBeUndefined();
});

function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-fmt-'));
  process.chdir(dir);
  return fn(dir).finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('format runs the script the project already defines', async () =>
  inTempDir(async (dir) => {
    // A script that touches a file, so the assertion is that the formatter ran
    // rather than that some formatter binary happens to be installed.
    await Bun.write(join(dir, 'marker.js'), 'require("fs").writeFileSync("formatted.txt", "yes")');
    await Bun.write(join(dir, 'package.json'), JSON.stringify({ scripts: { format: 'node marker.js' } }));

    await formatPlugin.afterTurn!();
    expect(await Bun.file(join(dir, 'formatted.txt')).text()).toBe('yes');
  }), 30_000);

test('format does nothing when the project defines no formatter', async () =>
  inTempDir(async (dir) => {
    await Bun.write(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
    // No throw and no side effect: a project without a format script gets nothing.
    await formatPlugin.afterTurn!();
    expect(await Bun.file(join(dir, 'formatted.txt')).exists()).toBe(false);
  }), 30_000);

test('format survives a manifest it cannot parse', async () =>
  inTempDir(async (dir) => {
    await Bun.write(join(dir, 'package.json'), '{ not json');
    await formatPlugin.afterTurn!();
    expect(true).toBe(true);
  }), 30_000);

test('format does nothing in a directory with no manifest at all', async () =>
  inTempDir(async () => {
    await formatPlugin.afterTurn!();
    expect(true).toBe(true);
  }), 30_000);

test('a throwing afterTurn does not stop the other plugins', async () => {
  let ran = 0;
  const host = createHost([
    {
      name: 'broken',
      description: 'throws',
      afterTurn: () => {
        throw new Error('boom');
      },
    },
    { name: 'counter', description: 'counts', afterTurn: () => void ran++ },
  ]);

  await host.afterTurn();
  expect(ran).toBe(1);
});
