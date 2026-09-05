import { TODO_MARK } from '../notebook';

export type Line =
  | { key: string; kind: 'user'; text: string }
  | { key: string; kind: 'assistant'; text: string }
  | { key: string; kind: 'tool'; name: string; detail: string[]; result?: string; ok: boolean }
  | { key: string; kind: 'info'; text: string }
  | { key: string; kind: 'error'; text: string };

export type NewLine = Line extends infer T ? (T extends Line ? Omit<T, 'key'> : never) : never;

let seq = 0;
export const nextKey = () => `l${seq++}`;

export const clip = (s: string, n = 68) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** The single argument that identifies a call, for a tool with no richer formatter. */
export function preview(input: unknown): string {
  if (input === null || typeof input !== 'object') return String(input);
  const o = input as Record<string, unknown>;
  const first = o['command'] ?? o['path'] ?? o['pattern'] ?? o['url'] ?? o['description'] ?? o['question'] ?? o['name'];
  if (typeof first === 'string') return first.length > 90 ? `${first.slice(0, 90)}...` : first;

  // A tool with no obvious label, e.g. todo_write, gets a shape rather than a
  // JSON dump; the panels below already show the content.
  const todos = o['todos'];
  if (Array.isArray(todos)) return `${todos.length} task${todos.length === 1 ? '' : 's'}`;
  const keys = Object.keys(o);
  return keys.length === 0 ? '' : keys.slice(0, 3).join(', ');
}

/**
 * The arguments that matter for one call, one per line.
 *
 * `preview` picks a single field, which loses exactly the information a reader
 * wants: a `read_file` with an offset, a `grep` scoped by `include`, the twenty
 * paths a batch read is about to pull in. This is what goes under the tool line in
 * the transcript, beside the spinner while a call is in flight, and in the approval
 * prompt for any tool without a diff of its own.
 */
export function toolDetail(name: string, input: unknown): string[] {
  if (input === null || typeof input !== 'object') return [];
  const o = input as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
  const bool = (k: string) => o[k] === true;

  switch (name) {
    case 'read_file': {
      const range = num('offset')
        ? `lines ${num('offset')}${num('limit') ? `-${num('offset')! + num('limit')! - 1}` : '+'}`
        : undefined;
      return [clip(str('path') ?? ''), ...(range ? [range] : [])];
    }
    case 'read_many_files': {
      const files = Array.isArray(o['files']) ? (o['files'] as { path?: unknown }[]) : [];
      const paths = files.map((f) => (typeof f.path === 'string' ? f.path : '?'));
      // Every path, not a count: the point of showing this is knowing what is
      // about to enter the context. `.map((p) => clip(p))` rather than `.map(clip)`,
      // because the latter hands the array index to clip's width parameter and
      // truncates every line to nothing.
      return paths
        .slice(0, 8)
        .map((p) => clip(p))
        .concat(paths.length > 8 ? [`... ${paths.length - 8} more`] : []);
    }
    case 'write_file': {
      const content = str('content') ?? '';
      return [clip(str('path') ?? ''), `${content.split('\n').length} lines, ${content.length} chars`];
    }
    case 'edit_file': {
      const old = str('oldString') ?? '';
      return [
        clip(str('path') ?? ''),
        `- ${clip(old.split('\n')[0] ?? '', 60)}${old.includes('\n') ? ` (+${old.split('\n').length - 1} lines)` : ''}`,
        ...(bool('replaceAll') ? ['every occurrence'] : []),
      ];
    }
    case 'multi_edit': {
      const edits = Array.isArray(o['edits']) ? (o['edits'] as { oldString?: unknown }[]) : [];
      return [
        clip(str('path') ?? ''),
        ...edits.slice(0, 5).map((e, i) => {
          const old = typeof e.oldString === 'string' ? e.oldString : '';
          return `${i + 1}. - ${clip(old.split('\n')[0] ?? '', 58)}`;
        }),
        ...(edits.length > 5 ? [`... ${edits.length - 5} more edits`] : []),
      ];
    }
    case 'apply_patch': {
      const patch = str('patch') ?? '';
      const ops = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map(
        (m) => `${m[1]!.toLowerCase()} ${m[2]!.trim()}`,
      );
      const moves = [...patch.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => `move to ${m[1]!.trim()}`);
      return [...ops, ...moves].slice(0, 10).map((line) => clip(line));
    }
    case 'move_file':
      return [`${clip(str('from') ?? '', 40)} -> ${clip(str('to') ?? '', 40)}`];
    case 'delete_file':
      return [clip(str('path') ?? '')];
    case 'bash': {
      const timeout = num('timeout');
      return [
        ...(str('command') ?? '')
          .split('\n')
          .slice(0, 4)
          .map((l) => clip(l)),
        ...(timeout ? [`timeout ${Math.round(timeout / 1000)}s`] : []),
      ];
    }
    case 'grep': {
      const parts = [`/${str('pattern') ?? ''}/`];
      if (str('include')) parts.push(`in ${str('include')}`);
      if (bool('ignoreCase')) parts.push('case-insensitive');
      if (bool('includeIgnored')) parts.push('including ignored files');
      return [clip(parts.join('  '), 90)];
    }
    case 'glob':
      return [clip(str('pattern') ?? ''), ...(bool('includeIgnored') ? ['including ignored files'] : [])];
    case 'list_dir':
      return [clip(str('path') ?? '.'), `depth ${num('depth') ?? 2}`];
    case 'web_fetch':
      return [clip(str('url') ?? '', 90)];
    case 'task': {
      const kind = str('kind') ?? 'explore';
      return [`${kind}${kind === 'worker' ? ' (writes)' : ''}: ${clip(str('description') ?? '')}`];
    }
    case 'todo_write': {
      const todos = Array.isArray(o['todos']) ? (o['todos'] as { content?: unknown; status?: unknown }[]) : [];
      return todos.slice(0, 6).map((t) => `${String(t.status ?? '')}: ${clip(String(t.content ?? ''), 56)}`);
    }
    case 'git_show':
      return [str('ref') ?? '', ...(str('path') ? [clip(str('path')!)] : [])];
    case 'git_log':
      return [`${num('limit') ?? 15} commits`, ...(str('path') ? [clip(str('path')!)] : [])];
    case 'git_diff':
      return [bool('staged') ? 'staged' : 'working tree', ...(str('path') ? [clip(str('path')!)] : [])];
    case 'git_branch':
      return [bool('remote') ? 'local and remote' : 'local'];
    case 'git_blame': {
      const from = num('startLine');
      return [clip(str('path') ?? ''), ...(from ? [`lines ${from}-${num('endLine') ?? from + 40}`] : [])];
    }
    case 'remember':
      return [`${str('kind') ?? 'fact'}: ${clip(str('text') ?? '', 60)}`];
    case 'recall':
    case 'forget':
      return [clip(str('query') ?? str('text') ?? '')];
    case 'skill':
      return [str('name') ?? ''];
    default: {
      const label = preview(input);
      return label ? [clip(label, 90)] : [];
    }
  }
}

/** First line of a tool result, so the transcript shows an outcome not just a call. */
export function resultSummary(name: string, output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  if (!text) return '';

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const first = lines[0] ?? '';

  // grep and glob return one hit per line, so the count is the useful summary.
  if (name === 'grep' || name === 'glob') {
    if (/^No (matches|files matched)/.test(first)) return first;
    return `${lines.length} ${name === 'grep' ? 'hit' : 'path'}${lines.length === 1 ? '' : 's'}`;
  }
  if (name === 'read_file' || name === 'read_many_files') return `${lines.length} lines`;
  if (name === 'bash') {
    const exit = /^exit: (\d+)/.exec(first);
    return exit ? `exit ${exit[1]}${lines.length > 1 ? `, ${lines.length - 1} lines out` : ''}` : clip(first);
  }
  return clip(first, 78);
}

/**
 * Attaches a result to the most recent unanswered call of that tool.
 *
 * Matched on name rather than call id because the transcript is a flat list of
 * committed lines, and a parallel pair of calls to the same tool is rare enough
 * that "the newest one still waiting" is right in practice and cheap.
 */
export function withResult(lines: Line[], name: string, result: string, ok: boolean): Line[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.kind !== 'tool' || line.name !== name || line.result !== undefined) continue;
    const next = [...lines];
    next[i] = { ...line, result, ok };
    return next;
  }
  return lines;
}

/** A task list as markdown, for the `/todos` panel. */
export const todoLines = (todos: readonly { status: keyof typeof TODO_MARK; content: string; note?: string }[]) =>
  todos.length > 0
    ? todos.map((t) => `- ${TODO_MARK[t.status]} ${t.content}${t.note ? ` (${t.note})` : ''}`).join('\n')
    : 'No task list yet.';
