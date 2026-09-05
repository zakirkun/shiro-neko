import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIT_TOOL_NAMES,
  gitBlameTool,
  gitBranchTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitStatusTool,
  gitTools,
} from '../src/tools-git';

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
  dir = mkdtempSync(join(tmpdir(), 'shiro-git-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

async function repoWithOneCommit(): Promise<void> {
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await Bun.write(join(dir, 'app.ts'), 'export const port = 8080;\n');
  await git('add', '.');
  await git('commit', '-m', 'add the server port');
}

test('every git tool is registered and named consistently', () => {
  // git_commit_message is built in src/commit.ts with the model at construction,
  // so it is not part of the static gitTools object — but it belongs to the set.
  expect(GIT_TOOL_NAMES.sort()).toEqual([
    'git_blame',
    'git_branch',
    'git_commit_message',
    'git_diff',
    'git_log',
    'git_show',
    'git_status',
  ]);
  expect([...Object.keys(gitTools), 'git_commit_message'].sort()).toEqual(GIT_TOOL_NAMES.sort());
});

test('git_branch marks the current branch and lists the others', async () => {
  await repoWithOneCommit();
  const one = await run(gitBranchTool, {});
  expect(one).toContain('* main');

  await git('branch', 'feature/pagination');
  const two = await run(gitBranchTool, {});
  expect(two).toContain('* main');
  expect(two).toContain('feature/pagination');
  expect(two).toContain('add the server port');
});

test('git_branch outside a repository says so', async () => {
  expect(run(gitBranchTool, {})).rejects.toThrow(/not a git repository/);
});

test('git_status names the branch and describes each change', async () => {
  await repoWithOneCommit();
  expect(await run(gitStatusTool, {})).toContain('working tree clean');

  await Bun.write(join(dir, 'app.ts'), 'export const port = 9090;\n');
  await Bun.write(join(dir, 'new.ts'), 'x\n');

  const out = await run(gitStatusTool, {});
  expect(out).toContain('On main');
  expect(out).toContain('app.ts');
  expect(out).toContain('modified');
  expect(out).toContain('new.ts');
  expect(out).toContain('untracked');
});

test('git_status separates staged from unstaged', async () => {
  await repoWithOneCommit();
  await Bun.write(join(dir, 'app.ts'), 'export const port = 9090;\n');
  await git('add', 'app.ts');

  expect(await run(gitStatusTool, {})).toContain('staged modified');
});

test('git_diff shows the working tree, and staged on request', async () => {
  await repoWithOneCommit();
  expect(await run(gitDiffTool, {})).toBe('No uncommitted changes.');

  await Bun.write(join(dir, 'app.ts'), 'export const port = 9090;\n');
  const unstaged = await run(gitDiffTool, {});
  expect(unstaged).toContain('-export const port = 8080;');
  expect(unstaged).toContain('+export const port = 9090;');

  expect(await run(gitDiffTool, { staged: true })).toBe('Nothing staged.');
  await git('add', 'app.ts');
  expect(await run(gitDiffTool, { staged: true })).toContain('9090');
});

test('git_diff narrows to a path', async () => {
  await repoWithOneCommit();
  await Bun.write(join(dir, 'app.ts'), 'changed\n');
  await Bun.write(join(dir, 'other.ts'), 'also changed\n');
  await git('add', 'other.ts');
  await git('commit', '-m', 'add other');
  await Bun.write(join(dir, 'other.ts'), 'changed again\n');

  const out = await run(gitDiffTool, { path: 'app.ts' });
  expect(out).toContain('app.ts');
  expect(out).not.toContain('other.ts');
});

test('git_log lists commits newest first and honours the limit', async () => {
  await repoWithOneCommit();
  await Bun.write(join(dir, 'app.ts'), 'export const port = 9090;\n');
  await git('commit', '-am', 'bump the port');

  const out = await run(gitLogTool, {});
  expect(out.split('\n')[0]).toContain('bump the port');
  expect(out).toContain('add the server port');
  expect(out).toContain('Test');

  expect((await run(gitLogTool, { limit: 1 })).split('\n')).toHaveLength(1);
});

test('git_show renders one commit with its diff', async () => {
  await repoWithOneCommit();
  const out = await run(gitShowTool, { ref: 'HEAD' });
  expect(out).toContain('add the server port');
  expect(out).toContain('+export const port = 8080;');
});

test('git_show reports a bad ref rather than returning nothing', async () => {
  await repoWithOneCommit();
  expect(run(gitShowTool, { ref: 'no-such-ref' })).rejects.toThrow();
});

test('git_blame attributes each line and narrows by range', async () => {
  await repoWithOneCommit();
  const out = await run(gitBlameTool, { path: 'app.ts' });
  expect(out).toContain('Test');
  expect(out).toContain('export const port = 8080;');

  expect(await run(gitBlameTool, { path: 'app.ts', startLine: 1, endLine: 1 })).toContain('8080');
});

test('outside a repository every tool fails with a clear message, not git porcelain', async () => {
  for (const [name, t] of Object.entries(gitTools)) {
    const input =
      name === 'git_show' ? { ref: 'HEAD' } : name === 'git_blame' ? { path: 'nothing.ts' } : ({} as never);
    expect(run(t as never, input as never), name).rejects.toThrow(/not a git repository/i);
  }
});

test('an argument that looks like a shell injection is passed through as one argument', async () => {
  await repoWithOneCommit();
  // argv spawning, not a shell string, so this can only ever be a pathspec.
  const out = await run(gitLogTool, { path: '; touch pwned.txt' }).catch((e: Error) => e.message);
  expect(await Bun.file(join(dir, 'pwned.txt')).exists()).toBe(false);
  expect(out).toBeTruthy();
});
