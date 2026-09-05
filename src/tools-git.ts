import { tool } from 'ai';
import { z } from 'zod';

const MAX_OUTPUT = 30_000;
const MAX_LOG = 40;

const cap = (s: string) =>
  s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT)}\n... [truncated ${s.length - MAX_OUTPUT} chars]`;

type GitResult = { ok: true; stdout: string } | { ok: false; message: string };

/**
 * Runs git with an argument array, never a shell string.
 *
 * Arguments come from model output, so a shell would make `git log --author="; rm -rf /"`
 * an injection. Spawning the binary directly with a fixed argv removes that entirely,
 * which is also why these tools can be auto-approved.
 */
export async function git(args: string[], cwd: string, timeout = 30_000): Promise<GitResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', timeout });
  } catch {
    return { ok: false, message: 'git is not installed or not on PATH.' };
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    const message = stderr.trim() || stdout.trim() || `git exited ${code}`;
    if (/not a git repository/i.test(message)) {
      return { ok: false, message: `${cwd} is not a git repository.` };
    }
    return { ok: false, message };
  }

  return { ok: true, stdout };
}

const run = async (args: string[], empty: string): Promise<string> => {
  const result = await git(args, process.cwd());
  if (!result.ok) throw new Error(result.message);
  return cap(result.stdout.trim() || empty);
};

const STATUS_LABEL: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflicted',
  '?': 'untracked',
  '!': 'ignored',
};

export const gitStatusTool = tool({
  description:
    'Working tree status: current branch, and which files are staged, modified, or untracked. ' +
    'Use it before proposing a commit, and to see what you have changed so far.',
  inputSchema: z.object({}),
  execute: async () => {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], process.cwd());
    if (!branch.ok) throw new Error(branch.message);

    const status = await git(['status', '--porcelain=v1'], process.cwd());
    if (!status.ok) throw new Error(status.message);

    const lines = status.stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return `On ${branch.stdout.trim()}, working tree clean.`;

    // Porcelain v1 packs staged and unstaged state into two leading columns; naming
    // them is the difference between the model understanding the state and guessing.
    const described = lines.slice(0, 200).map((line) => {
      const staged = line[0] ?? ' ';
      const unstaged = line[1] ?? ' ';
      const path = line.slice(3);
      const parts: string[] = [];
      if (staged !== ' ' && staged !== '?') parts.push(`staged ${STATUS_LABEL[staged] ?? staged}`);
      if (unstaged !== ' ') parts.push(`${STATUS_LABEL[unstaged] ?? unstaged}`);
      return `${path}  (${parts.join(', ') || 'unknown'})`;
    });

    return cap([`On ${branch.stdout.trim()}, ${lines.length} changed:`, ...described].join('\n'));
  },
});

export const gitDiffTool = tool({
  description:
    'Unified diff of uncommitted changes. Pass staged to see what is staged instead, or a path to narrow it. ' +
    'Use it to review your own edits before claiming they are done.',
  inputSchema: z.object({
    staged: z.boolean().optional().describe('Diff the index against HEAD instead of the working tree'),
    path: z.string().optional().describe('Limit the diff to one file or directory'),
  }),
  execute: async ({ staged, path }) => {
    const args = ['diff', '--no-color'];
    if (staged) args.push('--staged');
    if (path) args.push('--', path);
    return run(args, staged ? 'Nothing staged.' : 'No uncommitted changes.');
  },
});

export const gitLogTool = tool({
  description:
    'Recent commits, newest first: short hash, date, author, subject. Pass a path to see only commits touching it. ' +
    'Use it to find when something changed and who changed it.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(MAX_LOG).optional().describe(`Commits to return, default 15, max ${MAX_LOG}`),
    path: z.string().optional().describe('Only commits touching this file or directory'),
  }),
  execute: async ({ limit, path }) => {
    const args = ['log', `-n${limit ?? 15}`, '--date=short', '--pretty=format:%h  %ad  %an  %s'];
    if (path) args.push('--', path);
    return run(args, 'No commits.');
  },
});

export const gitShowTool = tool({
  description:
    'One commit in full: message, author, and its diff. Takes a hash, tag, or ref like HEAD~2. ' +
    'Use it after git_log to see what a specific commit actually did.',
  inputSchema: z.object({
    ref: z.string().describe('Commit hash, tag, or ref'),
    path: z.string().optional().describe('Limit the diff to one file'),
  }),
  execute: async ({ ref, path }) => {
    const args = ['show', '--no-color', '--date=short', ref];
    if (path) args.push('--', path);
    return run(args, 'Nothing to show.');
  },
});

export const gitBlameTool = tool({
  description:
    'Who last changed each line of a file, with the commit and date. Narrow with startLine and endLine. ' +
    'Use it when a line looks wrong and its history explains why.',
  inputSchema: z.object({
    path: z.string().describe('File to blame'),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  execute: async ({ path, startLine, endLine }) => {
    const args = ['blame', '--date=short', '-w'];
    if (startLine) args.push('-L', `${startLine},${endLine ?? startLine + 40}`);
    args.push('--', path);
    return run(args, 'No blame output.');
  },
});

export const gitBranchTool = tool({
  description:
    'Branches in this repository, newest commit first, with the current one marked. Pass remote to include ' +
    'remote-tracking branches. Use it before proposing a branch name, so a name already taken is obvious.',
  inputSchema: z.object({
    remote: z.boolean().optional().describe('Include remote-tracking branches'),
  }),
  execute: async ({ remote }) => {
    const args = [
      'branch',
      '--list',
      '--sort=-committerdate',
      '--format=%(if)%(HEAD)%(then)* %(else)  %(end)%(refname:short)  %(committerdate:short)  %(contents:subject)',
    ];
    if (remote) args.push('--all');
    return run(args, 'No branches yet.');
  },
});

export const gitTools = {
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  git_log: gitLogTool,
  git_show: gitShowTool,
  git_blame: gitBlameTool,
  git_branch: gitBranchTool,
};

/**
 * Read-only, so none of these ever prompt for approval.
 *
 * `git_commit_message` is built in `src/commit.ts` and wired in `cli.tsx`, because it
 * needs the model at construction. It belongs to this set for gating like the rest.
 */
export const GIT_TOOL_NAMES = [...Object.keys(gitTools), 'git_commit_message'];
