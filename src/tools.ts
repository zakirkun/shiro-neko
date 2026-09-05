import { tool } from 'ai';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { jail, posix, walk } from './ignore';
import { GIT_TOOL_NAMES, gitTools } from './tools-git';
import { NET_TOOL_NAMES, netTools } from './tools-net';

/** Max chars returned by any single tool. Beyond this the output is truncated. */
const MAX_OUTPUT = 30_000;
const MAX_GREP_HITS = 200;
/** Bytes sniffed for a NUL to decide a file is not text. */
const SNIFF_BYTES = 8192;

function cap(s: string): string {
  return s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT)}\n... [truncated ${s.length - MAX_OUTPUT} chars]`;
}

/**
 * A NUL byte in the first few KB means this is not text. Cheap, and the same
 * heuristic git and ripgrep use; without it a model can burn its whole context
 * on one accidental `read_file dist/binary`.
 */
async function isBinary(abs: string): Promise<boolean> {
  const bytes = new Uint8Array(await Bun.file(abs).slice(0, SNIFF_BYTES).arrayBuffer());
  return bytes.includes(0);
}

/**
 * One file, numbered. Shared by read_file and read_many_files so a batch read
 * cannot drift from a single read in numbering or in what it refuses.
 */
async function readNumbered(path: string, offset: number, limit: number): Promise<string> {
  const abs = jail(path);
  const file = Bun.file(abs);
  if (!(await file.exists())) throw new Error(`No such file: ${path}`);
  if (await isBinary(abs)) throw new Error(`${path} is a binary file, not text. Use bash if you need to inspect it.`);
  const lines = (await file.text()).split('\n');
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  return slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
}

export const readFileTool = tool({
  description: 'Read a UTF-8 text file. Returns contents with 1-based line numbers.',
  inputSchema: z.object({
    path: z.string().describe('File path relative to the workspace root'),
    offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
    limit: z.number().int().min(1).optional().describe('Max lines to return, default 2000'),
  }),
  execute: async ({ path, offset = 1, limit = 2000 }) => cap(await readNumbered(path, offset, limit)),
});

const MAX_BATCH_FILES = 20;

export const readManyFilesTool = tool({
  description:
    'Read several text files in one call. Use it when you already know which files you need — one round trip ' +
    'instead of one per file. Each file may set its own offset and limit. A path that cannot be read is reported ' +
    'in its own block and does not stop the others, so a wrong guess costs one line rather than the whole call.',
  inputSchema: z.object({
    files: z
      .array(
        z.object({
          path: z.string().describe('File path relative to the workspace root'),
          offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
          limit: z.number().int().min(1).optional().describe('Max lines to return, default 2000'),
        }),
      )
      .min(1)
      .max(MAX_BATCH_FILES)
      .describe(`The files to read, at most ${MAX_BATCH_FILES}`),
  }),
  execute: async ({ files }) => {
    // The whole point is one round trip, so the reads run together rather than
    // in sequence. A rejection is reported in place, not thrown.
    const blocks = await Promise.all(
      files.map(async ({ path, offset = 1, limit = 2000 }) => {
        try {
          return `===== ${path} =====\n${await readNumbered(path, offset, limit)}`;
        } catch (e) {
          return `===== ${path} =====\n[unreadable: ${e instanceof Error ? e.message : String(e)}]`;
        }
      }),
    );
    return cap(blocks.join('\n\n'));
  },
});

export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'update'; path: string; moveTo?: string; oldString: string; newString: string }
  | { kind: 'delete'; path: string };

const MARKER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE = /^\*\*\* Move to: (.+)$/;

/**
 * Parses the patch envelope. Exported so the format is testable without a disk.
 *
 * The shape follows Codex's `apply_patch`, which is worth copying for one reason:
 * models have seen it. A bespoke format costs schema description and gets malformed
 * calls until the model learns it.
 *
 *     *** Add File: src/new.ts
 *     +export const a = 1;
 *     *** Update File: src/old.ts
 *     *** Move to: src/renamed.ts
 *     -const a = 1;
 *     +const a = 2;
 *     *** Delete File: src/gone.ts
 */
export function parsePatch(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    const marker = MARKER.exec(line);
    if (!marker) throw new Error(`patch line ${i + 1} is not a marker or part of a hunk: ${line.slice(0, 60)}`);

    const kind = marker[1]!.toLowerCase() as 'add' | 'update' | 'delete';
    const path = marker[2]!.trim();
    i++;

    if (kind === 'delete') {
      ops.push({ kind: 'delete', path });
      continue;
    }

    let moveTo: string | undefined;
    const move = i < lines.length ? MOVE.exec(lines[i]!) : null;
    if (move) {
      if (kind === 'add') throw new Error(`${path}: "Move to" is only valid on an Update`);
      moveTo = move[1]!.trim();
      i++;
    }

    const removed: string[] = [];
    const added: string[] = [];
    while (i < lines.length && !MARKER.test(lines[i]!)) {
      const body = lines[i]!;
      if (body.startsWith('+')) added.push(body.slice(1));
      else if (body.startsWith('-')) removed.push(body.slice(1));
      else if (body.trim().length > 0) {
        throw new Error(`${path}: hunk line ${i + 1} starts with neither + nor -: ${body.slice(0, 60)}`);
      }
      i++;
    }

    if (kind === 'add') {
      if (removed.length > 0) throw new Error(`${path}: an Add cannot remove lines`);
      ops.push({ kind: 'add', path, content: added.join('\n') });
      continue;
    }

    if (removed.length === 0) throw new Error(`${path}: an Update needs at least one - line to locate the change`);
    ops.push({
      kind: 'update',
      path,
      ...(moveTo ? { moveTo } : {}),
      oldString: removed.join('\n'),
      newString: added.join('\n'),
    });
  }

  if (ops.length === 0) throw new Error('the patch is empty');
  return ops;
}

export const applyPatchTool = tool({
  description:
    'Apply one patch across several files: add, update, move, and delete in a single call. All or nothing — if any ' +
    'part fails, nothing is written. Use it when a change spans files that must land together, such as a rename ' +
    'plus its callers. For several edits to one file use multi_edit; for one edit use edit_file.\n' +
    'Format, one marker per file:\n' +
    '*** Add File: path      then + lines for the whole new file\n' +
    '*** Update File: path   then - lines to find and + lines to replace them with\n' +
    '*** Move to: path       directly after an Update marker, to rename\n' +
    '*** Delete File: path   no hunk\n' +
    'The - lines must match the file byte-for-byte and appear exactly once.',
  inputSchema: z.object({
    patch: z.string().describe('The patch envelope, as described above'),
  }),
  execute: async ({ patch }) => {
    const ops = parsePatch(patch);

    // Every operation is resolved and validated against the real files before
    // anything is written. A patch that fails on its fourth file must not leave
    // the first three applied — that is the only reason to have this tool rather
    // than a sequence of edit_file calls.
    const writes: { abs: string; content: string }[] = [];
    const removals: string[] = [];
    const summary: string[] = [];
    const seen = new Set<string>();

    for (const op of ops) {
      if (seen.has(op.path)) throw new Error(`${op.path} appears twice in one patch`);
      seen.add(op.path);
      const abs = jail(op.path);

      if (op.kind === 'delete') {
        if (!(await Bun.file(abs).exists())) throw new Error(`cannot delete ${op.path}: no such file`);
        removals.push(abs);
        summary.push(`deleted ${op.path}`);
        continue;
      }

      if (op.kind === 'add') {
        if (await Bun.file(abs).exists()) throw new Error(`cannot add ${op.path}: it already exists`);
        writes.push({ abs, content: op.content.endsWith('\n') ? op.content : `${op.content}\n` });
        summary.push(`added ${op.path}`);
        continue;
      }

      const file = Bun.file(abs);
      if (!(await file.exists())) throw new Error(`cannot update ${op.path}: no such file`);
      if (await isBinary(abs)) throw new Error(`cannot update ${op.path}: it is a binary file`);

      const before = await file.text();
      const count = before.split(op.oldString).length - 1;
      if (count === 0) throw new Error(`${op.path}: the - lines do not match the file. Nothing was written.`);
      if (count > 1) {
        throw new Error(`${op.path}: the - lines appear ${count} times. Add context to make them unique.`);
      }

      const after = before.replace(op.oldString, op.newString);
      if (op.moveTo) {
        const target = jail(op.moveTo);
        if (await Bun.file(target).exists()) throw new Error(`cannot move ${op.path}: ${op.moveTo} already exists`);
        writes.push({ abs: target, content: after });
        removals.push(abs);
        summary.push(`moved ${op.path} to ${op.moveTo}`);
      } else {
        writes.push({ abs, content: after });
        summary.push(`updated ${op.path}`);
      }
    }

    for (const { abs, content } of writes) await Bun.write(abs, content);
    for (const abs of removals) await Bun.file(abs).delete();

    return `Applied ${ops.length} change${ops.length === 1 ? '' : 's'}:\n${summary.map((s) => `- ${s}`).join('\n')}`;
  },
});

/**
 * A rewrite that collapses whitespace: similar character count, a fraction of the lines.
 *
 * A model under output pressure squeezes newlines and indentation before it cuts
 * markup — the byte count stays close, the line count does not. That rewrite is
 * rarely intended, so the result names it and the turn can fix it immediately.
 */
function collapsedRewrite(before: string, after: string): boolean {
  if (before.length === 0) return false;
  const ratio = after.length / before.length;
  if (ratio < 0.5 || ratio > 1.5) return false;
  return after.split('\n').length < before.split('\n').length / 2;
}

export const writeFileTool = tool({
  description: 'Create a file or overwrite it completely. Prefer edit_file for existing files.',
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async ({ path, content }) => {
    const abs = jail(path);
    const before = await Bun.file(abs).exists() ? await Bun.file(abs).text() : undefined;
    await Bun.write(abs, content);

    if (before !== undefined && collapsedRewrite(before, content)) {
      const lines = content.split('\n').length;
      return (
        `Wrote ${content.length} chars to ${path}, but it collapsed ${before.split('\n').length} lines into ${lines}. ` +
        'If that was not intended, re-send the content with its original newlines and indentation.'
      );
    }
    return `Wrote ${content.length} chars to ${path}`;
  },
});

export const editFileTool = tool({
  description:
    'Replace an exact string in a file. oldString must appear exactly once unless replaceAll is true. Include surrounding context to make oldString unique.',
  inputSchema: z.object({
    path: z.string(),
    oldString: z.string().describe('Exact text to find, including whitespace and indentation'),
    newString: z.string().describe('Replacement text'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one'),
  }),
  execute: async ({ path, oldString, newString, replaceAll = false }) => {
    if (oldString === newString) throw new Error('oldString and newString are identical');
    const abs = jail(path);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`No such file: ${path}`);
    const before = await file.text();

    const count = before.split(oldString).length - 1;
    if (count === 0) throw new Error(`oldString not found in ${path}`);
    if (count > 1 && !replaceAll) {
      throw new Error(`oldString appears ${count} times in ${path}. Add surrounding context or set replaceAll.`);
    }

    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    await Bun.write(abs, after);
    return `Replaced ${replaceAll ? count : 1} occurrence(s) in ${path}`;
  },
});

export const multiEditTool = tool({
  description:
    'Apply several exact-string edits to one file in a single call. Each edit sees the result of the previous one. ' +
    'All or nothing: if any oldString fails to match, or matches more than once without replaceAll, nothing is ' +
    'written. Prefer this over repeated edit_file calls on the same file — one approval, one write, no risk of ' +
    'leaving the file half-changed.',
  inputSchema: z.object({
    path: z.string(),
    edits: z
      .array(
        z.object({
          oldString: z.string().describe('Exact text to find, including whitespace and indentation'),
          newString: z.string().describe('Replacement text'),
          replaceAll: z.boolean().optional(),
        }),
      )
      .min(1)
      .describe('Edits in the order they should be applied'),
  }),
  execute: async ({ path, edits }) => {
    const abs = jail(path);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new Error(`No such file: ${path}`);

    const original = await file.text();
    let text = original;
    const applied: string[] = [];

    // Every edit is validated and applied in memory first. A failure on edit three
    // must not leave the first two on disk, which is the whole point of this tool.
    for (const [i, edit] of edits.entries()) {
      const { oldString, newString, replaceAll = false } = edit;
      if (oldString === newString) throw new Error(`edit ${i + 1}: oldString and newString are identical`);

      const count = text.split(oldString).length - 1;
      if (count === 0) {
        throw new Error(`edit ${i + 1}: oldString not found in ${path}. No edits were applied.`);
      }
      if (count > 1 && !replaceAll) {
        throw new Error(
          `edit ${i + 1}: oldString appears ${count} times in ${path}. Add surrounding context or set replaceAll. No edits were applied.`,
        );
      }

      text = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
      applied.push(`${replaceAll ? count : 1}x`);
    }

    if (text === original) throw new Error(`No change to ${path}: the edits cancel out.`);

    await Bun.write(abs, text);
    return `Applied ${edits.length} edit(s) to ${path} (${applied.join(', ')})`;
  },
});

export const globTool = tool({
  description:
    'Find files by glob pattern, e.g. "src/**/*.ts". Skips anything .gitignore excludes. Returns paths relative to the workspace root.',
  inputSchema: z.object({
    pattern: z.string(),
    limit: z.number().int().min(1).optional().describe('Max paths to return, default 200'),
    includeIgnored: z.boolean().optional().describe('Also search files git ignores'),
  }),
  execute: async ({ pattern, limit = 200, includeIgnored = false }) => {
    const glob = new Bun.Glob(pattern);
    const hits: string[] = [];
    for await (const rel of walk({ noIgnore: includeIgnored })) {
      if (!glob.match(rel)) continue;
      hits.push(rel);
      if (hits.length >= limit) break;
    }
    return hits.length ? hits.join('\n') : 'No files matched.';
  },
});

const MAX_TREE_ENTRIES = 300;

export const listDirTool = tool({
  description:
    'Directory tree, honouring .gitignore. Use it first to orient yourself in an unfamiliar project instead of ' +
    'guessing at glob patterns. Directories end with /, files show their size.',
  inputSchema: z.object({
    path: z.string().optional().describe('Directory to list, relative to the workspace root. Default the root.'),
    depth: z.number().int().min(1).max(6).optional().describe('How many levels deep, default 2'),
    includeIgnored: z.boolean().optional().describe('Also show files git ignores'),
  }),
  execute: async ({ path = '.', depth = 2, includeIgnored = false }) => {
    const root = jail(path);
    if (!(await isDir(root))) throw new Error(`Not a directory: ${path}`);

    const dirs = new Set<string>();
    const files: { rel: string; size: number }[] = [];

    for await (const rel of walk({ root, noIgnore: includeIgnored })) {
      const parts = rel.split('/');
      // Past the depth limit only the ancestors are interesting: the deepest one
      // stands in for everything under it.
      const shown = Math.min(parts.length - 1, depth);
      for (let i = 1; i <= shown; i++) dirs.add(parts.slice(0, i).join('/'));
      if (parts.length <= depth) files.push({ rel, size: Bun.file(join(root, rel)).size });
      if (files.length + dirs.size >= MAX_TREE_ENTRIES) break;
    }

    const indent = (rel: string) => '  '.repeat(rel.split('/').length - 1);
    const name = (rel: string) => rel.split('/').at(-1)!;
    const rows = [
      ...[...dirs].map((d) => ({ key: `${d}/`, line: `${indent(d)}${name(d)}/` })),
      ...files.map((f) => ({ key: f.rel, line: `${indent(f.rel)}${name(f.rel)}  ${humanSize(f.size)}` })),
    ].sort((a, b) => a.key.localeCompare(b.key));

    const label = path === '.' ? '.' : `${posix(path).replace(/\/+$/, '')}/`;
    if (rows.length === 0) return `${label} is empty (or everything in it is ignored).`;

    const capped = rows.length >= MAX_TREE_ENTRIES ? `\n... [${MAX_TREE_ENTRIES}-entry limit reached]` : '';
    return cap(`${label}\n${rows.map((r) => r.line).join('\n')}${capped}`);
  },
});

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

const humanSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
};

type GrepArgs = { pattern: string; include?: string; ignoreCase?: boolean; includeIgnored?: boolean };

/**
 * ripgrep is 10-100x faster than walking in JS and already understands
 * .gitignore and binary detection, so use it whenever it is installed.
 * Output shape stays identical to the fallback so the model sees one format.
 */
async function grepWithRipgrep({ pattern, include, ignoreCase, includeIgnored }: GrepArgs): Promise<string | undefined> {
  // --no-require-git: rg skips .gitignore outside a repo by default, but the JS
  // fallback always honours it, and the two paths must agree.
  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--no-require-git',
    '--max-count',
    String(MAX_GREP_HITS),
  ];
  if (ignoreCase) args.push('--ignore-case');
  if (includeIgnored) args.push('--no-ignore');
  if (include) args.push('--glob', include);
  args.push('--regexp', pattern, '.');

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(['rg', ...args], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  } catch {
    return undefined;
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // 0 = matches, 1 = no matches. Anything else means rg could not run the search.
  if (code > 1) {
    if (/regex parse error|error parsing/i.test(stderr)) throw new Error(`Invalid regex: ${stderr.trim()}`);
    return undefined;
  }
  if (code === 1) return 'No matches.';

  const hits = stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) return line;
      // rg prefixes every path with the search root and uses native separators.
      const rel = posix(m[1]!).replace(/^\.\//, '');
      return `${rel}:${m[2]}: ${m[3]!.slice(0, 300)}`;
    })
    .slice(0, MAX_GREP_HITS);

  return cap(hits.join('\n'));
}

async function grepInJs({ pattern, include = '**/*', ignoreCase, includeIgnored }: GrepArgs): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`);
  }

  const glob = new Bun.Glob(include);
  const hits: string[] = [];
  for await (const rel of walk({ noIgnore: includeIgnored })) {
    if (!glob.match(rel)) continue;
    const abs = resolve(process.cwd(), rel);
    let text: string;
    try {
      if (await isBinary(abs)) continue;
      text = await Bun.file(abs).text();
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.slice(0, 300)}`);
      if (hits.length >= MAX_GREP_HITS) return cap(`${hits.join('\n')}\n... [hit limit ${MAX_GREP_HITS}]`);
    }
  }
  return hits.length ? cap(hits.join('\n')) : 'No matches.';
}

export const grepTool = tool({
  description:
    'Search file contents with a regular expression. Skips binaries and anything .gitignore excludes. Returns path:line:text hits.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex source. ripgrep syntax when available, otherwise JavaScript'),
    include: z.string().optional().describe('Glob limiting which files are searched, default "**/*"'),
    ignoreCase: z.boolean().optional(),
    includeIgnored: z.boolean().optional().describe('Also search files git ignores'),
  }),
  execute: async (args) => (await grepWithRipgrep(args)) ?? (await grepInJs(args)),
});

export type BashOutput = { toolCallId: string; chunk: string };

/** Set by Session so long-running commands can report progress before exiting. */
let bashListener: ((out: BashOutput) => void) | undefined;

export function onBashOutput(fn: ((out: BashOutput) => void) | undefined): void {
  bashListener = fn;
}

async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  toolCallId: string,
): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  let all = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) continue;
    all += text;
    bashListener?.({ toolCallId, chunk: text });
  }
  return all;
}

type Running = { command: string; proc: Bun.Subprocess; interrupted: boolean; killed?: Promise<unknown> };

const running = new Map<string, Running>();

/**
 * Kills the shell and everything it started.
 *
 * `cmd /c` and `bash -lc` run the real command as a child, and killing only the
 * shell leaves that child alive holding both pipes open — the read never ends, so
 * the interrupt looks like it did nothing until the command finishes on its own.
 * Measured at 19 seconds for `ping -n 20` on Windows.
 *
 * The promise settles once the kill is done, which also matters on Windows, where a
 * surviving grandchild keeps its working directory locked against deletion.
 */
function killTree(proc: Bun.Subprocess): Promise<unknown> {
  if (process.platform === 'win32' && proc.pid) {
    try {
      const taskkill = Bun.spawn(['taskkill', '/PID', String(proc.pid), '/T', '/F'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      return taskkill.exited;
    } catch {
      // taskkill missing: fall through to the plain kill below.
    }
  }
  proc.kill();
  return proc.exited;
}

/**
 * Kills the commands currently in flight, leaving the turn alive.
 *
 * `esc` aborts everything, which means a runaway command can only be stopped by
 * throwing away the turn with it. This kills the process and lets `execute` throw,
 * so the model receives a tool error and takes its next step knowing what happened.
 * Returns the commands killed, for the notice shown to the user.
 */
export function interruptBash(): string[] {
  const killed: string[] = [];
  for (const entry of running.values()) {
    entry.interrupted = true;
    entry.killed = killTree(entry.proc);
    killed.push(entry.command);
  }
  return killed;
}

export const bashTool = tool({
  description:
    'Run a shell command in the workspace root. Use for builds, tests, git, and package managers. ' +
    'Output streams live and the user can interrupt a command with ctrl-c without ending the turn.',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().int().min(1000).max(600_000).optional().describe('Timeout in ms, default 120000'),
  }),
  execute: async ({ command, timeout = 120_000 }, { toolCallId, abortSignal }) => {
    const shell = process.platform === 'win32' ? ['cmd', '/c', command] : ['bash', '-lc', command];
    const proc = Bun.spawn(shell, {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });

    const entry: Running = { command, proc, interrupted: false };
    running.set(toolCallId, entry);

    try {
      // Drained concurrently: a command that fills one pipe while we block on the
      // other would deadlock, and buffering both hides progress for minutes.
      const [stdout, stderr, exitCode] = await Promise.all([
        pump(proc.stdout as ReadableStream<Uint8Array>, toolCallId),
        pump(proc.stderr as ReadableStream<Uint8Array>, toolCallId),
        proc.exited,
      ]);

      const body = [stdout.trim() && `stdout:\n${stdout.trim()}`, stderr.trim() && `stderr:\n${stderr.trim()}`]
        .filter(Boolean)
        .join('\n\n');

      // Thrown rather than returned: the model must not read a killed command as
      // a command that ran and failed on its own terms.
      if (entry.interrupted) {
        throw new Error(
          cap(
            `The user interrupted this command. It did not finish, so its effects are unknown.\n${
              body || '(no output before it was killed)'
            }`,
          ),
        );
      }

      return cap(
        [
          `exit: ${exitCode}`,
          proc.signalCode && `(killed by ${proc.signalCode}; timeout is ${timeout}ms)`,
          body,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    } finally {
      // Awaited so the process really is gone before the tool returns. On Windows a
      // surviving grandchild holds the cwd open, which breaks the very next command.
      await entry.killed;
      running.delete(toolCallId);
    }
  },
});

export const moveFileTool = tool({
  description:
    'Move or rename one file. Creates the target directory. Refuses if the source is missing or the target ' +
    'already exists, so a rename cannot silently overwrite work. For a rename plus its callers in one step, ' +
    'use apply_patch.',
  inputSchema: z.object({
    from: z.string().describe('Existing file path'),
    to: z.string().describe('New path, including the filename'),
  }),
  execute: async ({ from, to }) => {
    const source = jail(from);
    const target = jail(to);
    if (source === target) throw new Error('from and to are the same path');

    const file = Bun.file(source);
    if (!(await file.exists())) throw new Error(`No such file: ${from}`);
    if (await Bun.file(target).exists()) throw new Error(`${to} already exists. Delete it first or pick another name.`);

    await Bun.write(target, file);
    await file.delete();
    return `Moved ${from} to ${to}`;
  },
});

export const deleteFileTool = tool({
  description:
    'Delete one file. Refuses a directory: removing a tree is what the guard plugin blocks in bash, and it is ' +
    'not something to do implicitly. Delete the files you mean, one call each.',
  inputSchema: z.object({
    path: z.string().describe('File to delete'),
  }),
  execute: async ({ path }) => {
    const abs = jail(path);

    // Bun.file on a directory reports exists() false, so the stat is what
    // distinguishes "missing" from "a directory" and gives the right refusal.
    let entry: Awaited<ReturnType<typeof stat>>;
    try {
      entry = await stat(abs);
    } catch {
      throw new Error(`No such file: ${path}`);
    }
    if (entry.isDirectory()) throw new Error(`${path} is a directory. Delete its files individually.`);

    await Bun.file(abs).delete();
    return `Deleted ${path} (${entry.size} bytes)`;
  },
});

export const tools = {
  read_file: readFileTool,
  read_many_files: readManyFilesTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  multi_edit: multiEditTool,
  apply_patch: applyPatchTool,
  move_file: moveFileTool,
  delete_file: deleteFileTool,
  list_dir: listDirTool,
  glob: globTool,
  grep: grepTool,
  bash: bashTool,
  ...gitTools,
  ...netTools,
};

/**
 * Tool sets, so a set can be switched off before the schema cost grows.
 *
 * Measured at ~550 chars of JSON schema per tool on every request, and selection
 * accuracy falls as the list grows, so this is both a cost and a quality knob.
 * `core` is not listable here: without read, edit, and bash the agent is not an agent.
 *
 * `net` is the exception that is off unless asked for. Every other tool stays inside
 * the workspace; `web_fetch` reaches the internet and brings a stranger's text back
 * into the context, which is a decision rather than a default.
 */
export const TOOL_SETS = {
  core: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'],
  'edit-plus': ['multi_edit', 'list_dir', 'read_many_files', 'apply_patch', 'move_file', 'delete_file'],
  git: GIT_TOOL_NAMES,
  net: NET_TOOL_NAMES,
} as const satisfies Record<string, readonly string[]>;

export type ToolSetName = keyof typeof TOOL_SETS;

export const TOOL_SET_NAMES = Object.keys(TOOL_SETS) as ToolSetName[];

export const isToolSetName = (v: string): v is ToolSetName => (TOOL_SET_NAMES as string[]).includes(v);

/** Sets offered when the config says nothing. `net` is opt-in. */
export const DEFAULT_TOOL_SETS: ToolSetName[] = ['core', 'edit-plus', 'git'];

/** Which set a tool came from, for `/tools`. Session, plugin, and MCP tools have none. */
export function toolSetOf(name: string): ToolSetName | undefined {
  return TOOL_SET_NAMES.find((set) => (TOOL_SETS[set] as readonly string[]).includes(name));
}

/**
 * Names to withhold given the enabled sets. A tool belonging to no set is never
 * withheld: session, plugin, and MCP tools are not part of this budget.
 *
 * Omitting `toolSets` entirely means the defaults, not everything — `net` has to be
 * asked for by name.
 */
export function disabledToolNames(enabled: readonly ToolSetName[] | undefined): string[] {
  const live = new Set<ToolSetName>([...(enabled ?? DEFAULT_TOOL_SETS), 'core']);
  return TOOL_SET_NAMES.filter((set) => !live.has(set)).flatMap((set) => [...TOOL_SETS[set]]);
}

/** Tools that mutate the workspace or run arbitrary code always ask the user first. */
export const MUTATING_TOOLS = [
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'move_file',
  'delete_file',
  'bash',
] as const;

export { jail };
