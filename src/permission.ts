/**
 * Permission rules: which tool calls run, which ask, which are refused.
 *
 * The old model gated by tool name alone, which made `bash` a single yes/no for
 * both `git status` and `rm -rf`. A user holding `a` through a batch approves the
 * second along with the first, so the gate stopped meaning anything. Rules match
 * the tool's *subject* — the command, the path, the pattern — so `git *` can be
 * allowed while `*` still asks.
 *
 * Pure on purpose: no IO, no UI, so precedence and matching are testable without
 * a terminal or a model.
 */

export type Decision = 'allow' | 'ask' | 'deny';

/** A rule set for one tool: subject pattern to decision. `*` is the catch-all. */
export type ToolRules = Record<string, Decision>;

/** Either one decision for every call, or per-subject rules. */
export type PermissionEntry = Decision | ToolRules;

export type PermissionConfig = Record<string, PermissionEntry>;

const DECISIONS = new Set<Decision>(['allow', 'ask', 'deny']);

export const isDecision = (v: unknown): v is Decision => typeof v === 'string' && DECISIONS.has(v as Decision);

/**
 * Glob-ish matching: `*` spans any characters, `?` exactly one.
 *
 * Not a regex, deliberately. A rule comes from a config file a human wrote, and
 * `rm *` should mean what it looks like rather than "rm followed by anything,
 * where `*` is a quantifier on a space".
 */
export function matchPattern(pattern: string, subject: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = `^${escaped.replaceAll('*', '[\\s\\S]*').replaceAll('?', '[\\s\\S]')}$`;
  try {
    return new RegExp(source).test(subject);
  } catch {
    return false;
  }
}

/**
 * The text a rule for this tool matches against.
 *
 * One field per tool, chosen so the rule reads like the thing being gated: a
 * command for `bash`, a path for anything touching the filesystem, the query for
 * a search. A tool with no obvious subject matches only `*`, which is why this
 * returns undefined rather than an empty string — an empty subject would match
 * a `*` rule and a `?` rule differently for no good reason.
 */
export function subjectOf(tool: string, input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;

  const str = (key: string) => (typeof o[key] === 'string' ? (o[key] as string) : undefined);

  switch (tool) {
    case 'bash':
      return str('command');
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
    case 'delete_file':
    case 'list_dir':
    case 'git_blame':
      return str('path');
    case 'move_file': {
      // Both ends matter: a rule denying `src/generated/*` must catch a move that
      // lands there as well as one that starts there.
      const from = str('from');
      const to = str('to');
      const both = [from, to].filter((p): p is string => p !== undefined);
      return both.length > 0 ? both.join(' ') : undefined;
    }
    case 'web_fetch':
      return str('url');
    case 'apply_patch': {
      // Every path the patch touches, so denying `src/generated/*` catches a patch
      // that includes one alongside files it may edit.
      const patch = str('patch');
      if (!patch) return undefined;
      const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
      const moves = [...patch.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => m[1]!.trim());
      const all = [...paths, ...moves];
      return all.length > 0 ? all.join(' ') : undefined;
    }
    case 'read_many_files': {
      // A batch read is gated on the paths it asks for, so one bad path in
      // twenty is enough to trigger a rule.
      const files = o['files'];
      if (!Array.isArray(files)) return undefined;
      const paths = files
        .map((f) => (f && typeof f === 'object' ? (f as { path?: unknown }).path : undefined))
        .filter((p): p is string => typeof p === 'string');
      return paths.length > 0 ? paths.join(' ') : undefined;
    }
    case 'glob':
      return str('pattern');
    case 'grep':
      return str('pattern');
    case 'git_diff':
    case 'git_log':
      return str('path');
    case 'git_show':
      return str('ref');
    case 'task':
      return str('description');
    case 'skill':
      return str('name');
    default:
      return undefined;
  }
}

/**
 * A subject that is several strings at once is matched if a rule matches any of
 * them: denying `*.env` must catch a batch read that includes one, and denying
 * `src/generated/*` must catch a patch that touches one among five files.
 */
const MULTI = new Set(['read_many_files', 'apply_patch', 'move_file']);

const subjectsFor = (tool: string, subject: string): string[] =>
  MULTI.has(tool) ? subject.split(' ') : [subject];

export type Resolved = { decision: Decision; pattern: string | undefined };

/**
 * The decision for one call, with the pattern that produced it.
 *
 * Later rules win, so a config reads top to bottom: put `*` first and narrow
 * after it. Object key order is insertion order for string keys, which is what
 * makes that stable.
 *
 * Plain last-match-wins, with no special case for `deny`. An earlier attempt made
 * deny win outright, on the theory that a deny rule should be impossible to undo
 * by accident. It made the most useful configuration in the system unexpressible:
 *
 *     "edit_file": { "*": "deny", "src/generated/*": "allow" }
 *
 * Default-deny with narrow allows is what a careful user writes, and a narrow
 * exception to a broad deny is the same shape as `*.env` denied but
 * `*.env.example` allowed. Refusals that must never be configurable live in the
 * guard plugin instead, which runs ahead of this and which `--yolo` cannot reach.
 */
export function resolve(rules: PermissionEntry | undefined, tool: string, input: unknown): Resolved {
  if (rules === undefined) return { decision: 'ask', pattern: undefined };
  if (isDecision(rules)) return { decision: rules, pattern: undefined };

  const subject = subjectOf(tool, input);
  let hit: Resolved = { decision: 'ask', pattern: undefined };

  for (const [pattern, decision] of Object.entries(rules)) {
    if (!isDecision(decision)) continue;
    const matched =
      pattern === '*' ||
      (subject !== undefined && subjectsFor(tool, subject).some((s) => matchPattern(pattern, s)));
    if (matched) hit = { decision, pattern };
  }

  return hit;
}

/**
 * Defaults, applied when the config says nothing about a tool.
 *
 * Read-only tools run; anything that writes or executes asks. `.env` is denied on
 * read because a model that greps for a config value will find a credential, and
 * "it was in the context" is not recoverable.
 */
export const DEFAULT_PERMISSIONS: PermissionConfig = {
  read_file: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow', '*.pem': 'deny' },
  read_many_files: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow', '*.pem': 'deny' },
  write_file: 'ask',
  edit_file: 'ask',
  multi_edit: 'ask',
  apply_patch: 'ask',
  move_file: 'ask',
  delete_file: 'ask',
  bash: 'ask',
  web_fetch: 'ask',
};

/** Session, plugin, and read-only tools that never gate. */
const FREE = new Set([
  'glob',
  'grep',
  'list_dir',
  'task',
  'todo_write',
  'remember',
  'recall',
  'forget',
  'skill',
  'ask',
  'current_time',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'git_branch',
  'git_commit_message',
]);

export type PermissionOptions = {
  config?: PermissionConfig;
  /** --yolo: fold `ask` into `allow`. Never touches `deny`. */
  yolo?: boolean;
  /** Names that never prompt whatever the rules say, e.g. the subagent tool. */
  autoApprove?: readonly string[];
};

/**
 * Rules for a tool, config over defaults.
 *
 * Merged per tool rather than per pattern: a config that says anything about
 * `bash` replaces the default for `bash` entirely. Merging pattern-by-pattern
 * would leave a user unable to remove a default deny rule, which is the kind of
 * surprise that ends with someone disabling the whole system.
 */
function entryFor(tool: string, config: PermissionConfig | undefined): PermissionEntry | undefined {
  if (config && tool in config) return config[tool];
  if (config && !(tool in config)) {
    for (const [pattern, entry] of Object.entries(config)) {
      if (pattern.includes('*') && matchPattern(pattern, tool)) return entry;
    }
  }
  if (tool in DEFAULT_PERMISSIONS) return DEFAULT_PERMISSIONS[tool];
  if (FREE.has(tool)) return 'allow';
  // Unknown tool, which in practice means MCP or a plugin: ask.
  return 'ask';
}

export class Permissions {
  private readonly config: PermissionConfig | undefined;
  private readonly yolo: boolean;
  private readonly autoApprove: Set<string>;
  /** Patterns approved with `always` for the rest of this session. */
  private readonly granted = new Map<string, Set<string>>();

  constructor(opts: PermissionOptions = {}) {
    this.config = opts.config;
    this.yolo = opts.yolo ?? false;
    this.autoApprove = new Set(opts.autoApprove ?? []);
  }

  /**
   * What a session-wide `always` would whitelist.
   *
   * A bash command becomes its first word plus `*`, so approving `git status`
   * approves `git *` and not every command ever. Anything else falls back to the
   * tool's own catch-all, since a path pattern guessed from one path is more
   * likely to be wrong than useful.
   */
  suggest(tool: string, input: unknown): string {
    if (tool !== 'bash') return '*';
    const command = subjectOf(tool, input);
    if (!command) return '*';
    const head = command.trim().split(/\s+/)[0];
    return head ? `${head} *` : '*';
  }

  /** Records an `always` decision as a pattern rather than a bare tool name. */
  grant(tool: string, pattern: string): void {
    const set = this.granted.get(tool) ?? new Set<string>();
    set.add(pattern);
    this.granted.set(tool, set);
  }

  granted_(tool: string): string[] {
    return [...(this.granted.get(tool) ?? [])];
  }

  /** The decision for one call, and which pattern decided it. */
  check(tool: string, input: unknown): Resolved {
    const resolved = resolve(entryFor(tool, this.config), tool, input);
    if (resolved.decision === 'deny') return resolved;

    if (this.autoApprove.has(tool)) return { decision: 'allow', pattern: undefined };

    const subject = subjectOf(tool, input);
    for (const pattern of this.granted.get(tool) ?? []) {
      if (pattern === '*' || (subject !== undefined && matchPattern(pattern, subject))) {
        return { decision: 'allow', pattern };
      }
    }

    if (resolved.decision === 'ask' && this.yolo) return { decision: 'allow', pattern: resolved.pattern };
    return resolved;
  }
}

/**
 * Parses a `permission` config block, dropping anything malformed.
 *
 * A typo must not silently widen access. An unrecognised decision string is
 * dropped, which leaves the pattern unmatched and the tool on its default —
 * `ask` for anything that writes.
 */
export function parsePermissions(raw: unknown): PermissionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: PermissionConfig = {};

  for (const [tool, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (isDecision(entry)) {
      out[tool] = entry;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const rules: ToolRules = {};
    for (const [pattern, decision] of Object.entries(entry as Record<string, unknown>)) {
      if (isDecision(decision)) rules[pattern] = decision;
    }
    if (Object.keys(rules).length > 0) out[tool] = rules;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export { FREE as FREE_TOOLS };
