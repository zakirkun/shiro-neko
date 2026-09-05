/** What the session was, for the line printed as shiro exits. */
export type Farewell = {
  id: string;
  messages: number;
  title: string;
};

/** Long enough to be unique in practice, short enough to retype from the screen. */
const PREFIX = 8;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * The exit message: good bye, and how to pick this session up again.
 *
 * A session's id is a UUIDv7 nobody retypes, so the resume line shows the prefix
 * `resolveId` accepts alongside `-c`, which needs no id at all. An empty session was
 * never persisted, so it gets no resume command — pointing someone at `-c` that finds
 * nothing is worse than saying nothing.
 */
export function farewell({ id, messages, title }: Farewell): string {
  if (messages === 0) return 'Good bye. Nothing to save from this session.';

  const count = `${messages} message${messages === 1 ? '' : 's'}`;
  const named = title && title !== 'untitled' ? `: "${clip(title, 52)}"` : '';

  return [
    'Good bye.',
    `Saved ${count}${named}`,
    '',
    'Resume it with:',
    `  shiro -c                    newest session in this directory`,
    `  shiro -r ${id.slice(0, PREFIX)}           this session by id`,
  ].join('\n');
}
