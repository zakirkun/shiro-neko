import { afterEach, beforeEach, expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { variantByName } from '../src/agents';
import { createCommitMessageTool, COMMIT_TOOL_NAME } from '../src/commit';
import { Permissions } from '../src/permission';
import { TOOL_DOCS, systemPrompt } from '../src/prompt';
import { Session } from '../src/session';
import { disabledToolNames, toolSetOf } from '../src/tools';
import { GIT_TOOL_NAMES } from '../src/tools-git';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5 },
} as any;

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }),
});

const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

let dir: string;
let origCwd: string;

const run = <T>(t: { execute?: (input: T, opts: any) => unknown }, input: T) =>
  Promise.resolve(t.execute!(input, { toolCallId: 't1', messages: [] })) as Promise<string>;

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`);
}

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'shiro-commit-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

async function repoWithHistory(): Promise<void> {
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await Bun.write(join(dir, 'app.ts'), 'export const port = 8080;\n');
  await git('add', '.');
  await git('commit', '-m', 'add the server port');
  await Bun.write(join(dir, 'log.ts'), 'export function log() {}\n');
  await git('add', '.');
  await git('commit', '-m', 'add the log helper');
}

/** A model that records every call, so assertions can be made on the wire. */
function recordingModel(
  reply: string,
): { model: MockLanguageModelV4; seen: LanguageModelV4CallOptions[] } {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      seen.push(o);
      return stream(text(reply));
    },
    doGenerate: async (o) => {
      seen.push(o);
      return {
        content: [{ type: 'text', text: reply }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      } as any;
    },
  });
  return { model, seen };
}

test('the tool is named and registered under the git set', () => {
  expect(COMMIT_TOOL_NAME).toBe('git_commit_message');
  expect(GIT_TOOL_NAMES).toContain('git_commit_message');
  expect(toolSetOf('git_commit_message')).toBe('git');
});

test('nothing staged is a stated error, not a model call', async () => {
  await repoWithHistory();
  const { model, seen } = recordingModel('should not be called');

  const message = await run(createCommitMessageTool({ model }), {});
  expect(message).toContain('Nothing is staged');
  expect(seen).toHaveLength(0);
});

test('a staged change generates a message from the diff and the recent subjects', async () => {
  await repoWithHistory();
  await Bun.write(join(dir, 'app.ts'), 'export const port = 9090;\n');
  await git('add', 'app.ts');
  const { model, seen } = recordingModel('bump the server port to 9090');

  const message = await run(createCommitMessageTool({ model }), {});

  expect(message).toContain('bump the server port to 9090');
  // The nested call carries both halves of the evidence: the staged diff and the
  // repository's own subject style.
  const prompt = JSON.stringify(seen[0]?.prompt);
  expect(seen).toHaveLength(1);
  expect(prompt).toContain('+export const port = 9090;');
  expect(prompt).toContain('add the server port');
  expect(prompt).toContain('add the log helper');
  const system = JSON.stringify(seen[0]?.prompt.find((m) => m.role === 'system'));
  expect(system).toContain('commit message');
  expect(system).toContain('subject style');
});

test('the tool never commits: the repository is untouched after a generation', async () => {
  await repoWithHistory();
  await Bun.write(join(dir, 'app.ts'), 'export const port = 9090;\n');
  await git('add', 'app.ts');
  const { model } = recordingModel('bump the server port');

  await run(createCommitMessageTool({ model }), {});

  const head = await new Response(
    Bun.spawn(['git', 'log', '-1', '--pretty=format:%s'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }).stdout,
  ).text();
  expect(head).toBe('add the log helper');
  const status = await new Response(
    Bun.spawn(['git', 'status', '--porcelain'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }).stdout,
  ).text();
  expect(status).toContain('app.ts');
});

test('an oversized diff is truncated before it reaches the model', async () => {
  await repoWithHistory();
  await Bun.write(join(dir, 'big.ts'), 'x'.repeat(200_000));
  await git('add', 'big.ts');
  const { model, seen } = recordingModel('add big.ts');

  await run(createCommitMessageTool({ model }), {});

  const prompt = JSON.stringify(seen[0]?.prompt);
  expect(prompt.length).toBeLessThan(200_000);
  expect(prompt).toContain('truncated');
});

test('the model is told the convention and returns only the subject', async () => {
  await repoWithHistory();
  await Bun.write(join(dir, 'app.ts'), 'export const port = 9090;\n');
  await git('add', 'app.ts');
  const { model, seen } = recordingModel('Add the server port');

  const message = await run(createCommitMessageTool({ model }), {});

  // The reply is normalised: stripped of a model's wrapping prose and fenced
  // blocks, so what reaches the caller can be used as -m verbatim.
  expect(message).toBe('Add the server port');
  const system = String(seen[0]?.prompt.find((m) => m.role === 'system')?.content ?? '');
  expect(system).toContain('One line');
});

test('wiring: the tool is free, read-only, documented, and offered by the session', async () => {
  // Permission: no rule and no prompt, like the other git tools.
  const bare = new Permissions();
  expect(bare.check('git_commit_message', {}).decision).toBe('allow');

  // Variants: plan and review keep it.
  for (const name of ['plan', 'review']) {
    expect(variantByName(name)!.allowTools).toContain('git_commit_message');
  }

  // Prompt: guidance exists and only the offered tools are described.
  expect(TOOL_DOCS.map((d) => d.name)).toContain('git_commit_message');
  const prompt = systemPrompt({ cwd: dir, availableTools: ['git_commit_message'] });
  expect(prompt).toContain('git_commit_message');

  // Gating: switching the git set off withholds it from the wire.
  expect(disabledToolNames(['core', 'edit-plus'])).toContain('git_commit_message');
  expect(disabledToolNames(['core', 'edit-plus', 'git'])).not.toContain('git_commit_message');

  // Session end to end: the tool is offered and produces its message.
  const { model, seen } = recordingModel('refactor the port into a constant');
  const session = new Session({
    model,
    askApproval: async () => 'deny',
    extraTools: { git_commit_message: createCommitMessageTool({ model }) },
    autoApprove: ['git_commit_message'],
  });

  for await (const _ of session.send('suggest a commit message')) void _;
  const offered = (seen.find((o) => (o.tools ?? []).length > 0)?.tools ?? []).map((t) => t.name);
  expect(offered).toContain('git_commit_message');
});
