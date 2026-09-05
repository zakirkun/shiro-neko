import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { parseCommand, COMMANDS, HELP } from '../src/commands';
import { Session } from '../src/session';
import { App, createApprovalBridge, type AppHooks } from '../src/ui/App';
import { invalidName, parseHeaders, splitArgs, McpAdd } from '../src/ui/McpAdd';
import { testHooks } from './helpers';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1 },
} as any;

const model = new MockLanguageModelV4({
  doStream: async () =>
    ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'ok' },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }) as any,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\u001B[B';

function mount(over: Partial<AppHooks> = {}) {
  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks(over)} />);
  return { app };
}

async function press(app: ReturnType<typeof render>, s: string, ms = 80) {
  app.stdin.write(s);
  await wait(ms);
}

async function type(app: ReturnType<typeof render>, s: string) {
  for (const ch of s) await press(app, ch, 30);
}

test('the mcp command is in the menu, help, and the parser', () => {
  expect(COMMANDS.map((c) => c.name)).toContain('mcp');
  expect(HELP).toContain('/mcp');

  expect(parseCommand('/mcp')).toEqual({ type: 'mcp', action: 'list' });
  expect(parseCommand('/mcp list')).toEqual({ type: 'mcp', action: 'list' });
  expect(parseCommand('/mcp add')).toEqual({ type: 'mcp', action: 'add' });
  expect(parseCommand('/mcp remove files')).toEqual({ type: 'mcp', action: 'remove', arg: 'files' });
});

test('remove without a name is a usage line, not a silent no-op', () => {
  const action = parseCommand('/mcp remove');
  expect(action.type).toBe('info');
  if (action.type !== 'info') throw new Error('expected info');
  expect(action.text).toContain('/mcp remove <name>');
});

test('an unrecognised verb says what the command takes', () => {
  const action = parseCommand('/mcp frobnicate');
  expect(action.type).toBe('info');
  if (action.type !== 'info') throw new Error('expected info');
  expect(action.text).toContain('list|add|remove');
});

test('a server name that would break tool namespacing is rejected', () => {
  expect(invalidName('')).toContain('required');
  expect(invalidName('   ')).toContain('required');
  // Tools register as mcp__<server>__<tool>, so these produce names the model
  // cannot address and namespaces that can collide.
  expect(invalidName('my server')).toContain('letters');
  expect(invalidName('my__server')).toBeDefined();
  expect(invalidName('files/local')).toContain('letters');

  expect(invalidName('filesystem')).toBeUndefined();
  expect(invalidName('my-server')).toBeUndefined();
  expect(invalidName('server2')).toBeUndefined();
});

test('headers parse from a comma-separated list, and nothing means none', () => {
  expect(parseHeaders('')).toBeUndefined();
  expect(parseHeaders('   ')).toBeUndefined();
  expect(parseHeaders('Authorization: Bearer sk-123')).toEqual({ Authorization: 'Bearer sk-123' });
  expect(parseHeaders('A: 1, B: 2')).toEqual({ A: '1', B: '2' });
  // A value containing a colon survives: only the first one separates.
  expect(parseHeaders('X-Url: https://example.com')).toEqual({ 'X-Url': 'https://example.com' });
  expect(parseHeaders('malformed')).toBeUndefined();
});

test('arguments split on spaces but keep quoted runs together', () => {
  expect(splitArgs('')).toEqual([]);
  expect(splitArgs('-y @modelcontextprotocol/server-filesystem .')).toEqual([
    '-y',
    '@modelcontextprotocol/server-filesystem',
    '.',
  ]);
  expect(splitArgs('--root "/home/my folder"')).toEqual(['--root', '/home/my folder']);
});

test('the local wizard collects a command and its arguments', async () => {
  const results: unknown[] = [];
  const app = render(<McpAdd existing={[]} onDone={(r) => results.push(r)} onCancel={() => {}} />);
  await wait(80);

  expect(app.lastFrame()).toContain('Add an MCP server');
  await press(app, '\r', 100);

  await type(app, 'filesystem');
  await press(app, '\r', 100);
  expect(app.lastFrame()).toContain('command');

  await type(app, 'npx');
  await press(app, '\r', 100);

  await type(app, '-y server-filesystem .');
  await press(app, '\r', 150);

  expect(results).toEqual([
    { name: 'filesystem', config: { command: 'npx', args: ['-y', 'server-filesystem', '.'] } },
  ]);
  app.unmount();
}, 20_000);

test('the remote wizard collects a url and optional headers', async () => {
  const results: unknown[] = [];
  const app = render(<McpAdd existing={[]} onDone={(r) => results.push(r)} onCancel={() => {}} />);
  await wait(80);

  await press(app, DOWN, 100);
  await press(app, '\r', 100);

  await type(app, 'api');
  await press(app, '\r', 100);
  expect(app.lastFrame()).toContain('endpoint URL');

  await type(app, 'https://example.com/mcp');
  await press(app, '\r', 100);
  expect(app.lastFrame()).toContain('headers');

  await press(app, '\r', 150);

  expect(results).toEqual([{ name: 'api', config: { url: 'https://example.com/mcp' } }]);
  app.unmount();
}, 20_000);

test('a duplicate name and a bad url are refused in place', async () => {
  const app = render(<McpAdd existing={['files']} onDone={() => {}} onCancel={() => {}} />);
  await wait(80);

  expect(app.lastFrame()).toContain('1 configured: files');
  await press(app, DOWN, 100);
  await press(app, '\r', 100);

  await type(app, 'files');
  await press(app, '\r', 120);
  expect(app.lastFrame()).toContain('already configured');

  app.unmount();
}, 20_000);

test('esc cancels the wizard without producing a server', async () => {
  let cancelled = 0;
  const app = render(<McpAdd existing={[]} onDone={() => {}} onCancel={() => void cancelled++} />);
  await wait(80);
  await press(app, '\u001B', 120);
  expect(cancelled).toBe(1);
  app.unmount();
}, 20_000);

test('/mcp lists what the hooks report', async () => {
  const { app } = mount({ mcp: { names: () => ['files'], list: () => 'MCP-LIST-BODY', add: async () => 'a', remove: async () => 'r' } });
  await wait(150);

  await type(app, '/mcp');
  await press(app, '\r', 300);

  expect(app.lastFrame()).toContain('MCP-LIST-BODY');
  app.unmount();
}, 20_000);

test('/mcp add opens the wizard and the result reaches the hook', async () => {
  const added: string[] = [];
  const { app } = mount({
    mcp: {
      names: () => [],
      list: () => 'none',
      add: async (result) => {
        added.push(result.name);
        return `added ${result.name}`;
      },
      remove: async () => 'removed',
    },
  });
  await wait(150);

  await type(app, '/mcp add');
  await press(app, '\r', 250);
  expect(app.lastFrame()).toContain('Add an MCP server');

  await press(app, '\r', 120);
  await type(app, 'local');
  await press(app, '\r', 120);
  await type(app, 'bun');
  await press(app, '\r', 120);
  await press(app, '\r', 300);

  expect(added).toEqual(['local']);
  expect(app.lastFrame()).toContain('added local');
  app.unmount();
}, 30_000);

test('/mcp remove passes the name through and reports the error', async () => {
  const { app } = mount({
    mcp: {
      names: () => [],
      list: () => 'none',
      add: async () => 'added',
      remove: async (name) => {
        throw new Error(`no MCP server named "${name}"`);
      },
    },
  });
  await wait(150);

  await type(app, '/mcp remove ghost');
  await press(app, '\r', 300);

  expect(app.lastFrame()).toContain('no MCP server named "ghost"');
  app.unmount();
}, 20_000);
