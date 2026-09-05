# Plugins

A plugin extends the agent in four ways: it can add tools, mark tools auto-approved, block
a tool call before it runs, and append to the system prompt. It can also run something after
each turn.

Two kinds exist, and only one can contain code:

- **Builtin** plugins are compiled into the binary and may do anything in the interface below.
- **Installed** plugins come from a registry as a JSON manifest of refusal rules. They are
  data: the guard evaluating them is compiled code, identical for every install. See
  [registry](registry.md).

Loading TypeScript from disk or a URL is deliberately not supported. A plugin that can block
tool calls can also lie about blocking them, and one that could execute could read every file
the agent can read. That is a sandbox problem, not a loader problem — see
[ROADMAP.md](../ROADMAP.md).

## Enabling

```json
{ "plugins": ["guard", "secrets", "protect", "time"] }
```

That is also the default when the field is absent, and it lists **builtin** plugins only.
Installed plugins are always active once present, because installing one was the decision to
enable it; remove it with `/registry remove <name>`.

`--no-plugins` disables everything, builtin and installed, including the guard. `/plugins`
lists what is active, marks installed entries, and reports any name that did not resolve.

## The interface

```ts
export type Plugin = {
  name: string;
  description: string;
  tools?: ToolSet;
  autoApprove?: readonly string[];
  beforeToolCall?: (ctx: { toolName: string; input: unknown; cwd: string }) => string | undefined | Promise<string | undefined>;
  afterTurn?: () => void | Promise<void>;
  appendix?: string;
};
```

`beforeToolCall` returning a string **blocks** the call, and the string is given to the model
as the reason. Returning `undefined` allows it.

Two decisions worth knowing about:

**A throwing hook blocks.** A guard that crashes must fail closed. Treating an exception as
"allow" would mean a bug in a security plugin silently disables it.

**Blocks are checked before approval.** `--yolo` skips prompts; it does not skip guards. A
plugin block is a refusal, not a permission question.

**A guard sees `bash` before the command runs, not while it runs.** The guard is the only thing
that can refuse a command outright; once one is running, `ctrl-c` is what stops it. Both matter:
a pattern the guard does not know about is still interruptible by hand.

## Builtins

### `guard` (default on)

Refuses irreversible shell commands outright. Approval alone is a weak defence here: a user
holding `a` through a batch of edits will approve one of these without reading it.

| Pattern | Why |
|---|---|
| `rm -rf`, `rm -f` | recursive or forced delete |
| `git reset --hard` | discards uncommitted work |
| `git clean -f` | deletes untracked files |
| `git push --force`, `--force-with-lease`, `-f` | rewrites remote history |
| `git branch -D` | deletes a branch without a merge check |
| `DROP TABLE`, `TRUNCATE` | destroys database data |
| `mkfs`, `dd of=/dev/…`, `> /dev/sd…` | writes to a raw device |
| `chmod 777` | makes files world-writable |
| `shutdown`, `reboot`, `halt` | affects the whole machine |
| `:(){ :\|:& };:` | fork bomb |
| `curl … \| sh`, `wget … \| sh` | pipes a download into a shell |

```
Blocked by the guard plugin: refusing "rm -rf build" (recursive or forced delete).
Ask the user to run it themselves if it is really needed.
```

The model is told to relay the command rather than work around it. `rm build/one-file.js`,
`git push origin feature`, and `git commit` all pass — the patterns target irreversibility,
not the commands themselves.

Two honest limits. The patterns match the command **string**, so `bash -c "$(echo cm0gLXJm | base64 -d)"`
is not caught, and neither is a script the agent wrote and then ran. And it only inspects `bash`:
a `write_file` overwriting something important is an approval question, not a guard question.

The guard is the last line before a command runs; `ctrl-c` is the one after. A pattern the guard
does not know about is still interruptible by hand — see [tools](tools.md#bash).

### `protect` (default on)

Refuses writes to files whose contents belong to a tool rather than to anyone editing them by
hand. This is a different failure from a secret: the repository looks fine and behaves wrongly,
and the breakage surfaces somewhere else entirely.

| Refused | Why |
|---|---|
| `.git/**` | git's own object store |
| `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`, `composer.lock`, `Gemfile.lock` | the package manager owns it |
| `node_modules/**` | an installed dependency |
| `vendor/**`, `target/debug/**`, `target/release/**` | vendored or build directory |
| `dist/**`, `build/**`, `out/**`, `.next/**`, `.nuxt/**`, `.svelte-kit/**`, `coverage/**` | generated output |
| `.venv/**`, `.tox/**`, `.mypy_cache/**`, `.ruff_cache/**`, `.turbo/**` | tool caches |

```
refusing to write bun.lock (a lockfile the package manager owns). Regenerate it with the
tool that owns it rather than editing it.
```

The message says what to do instead, which matters: a model told only "no" writes the same
content somewhere else. A lockfile is regenerated by `bun install`; build output is regenerated
by the build.

Both separators match, so `node_modules\react\index.js` is refused on Windows too. Lookalike
names are not: `src/gitignore-parser.ts`, `docs/dist-layout.md`, and `distributed/queue.ts` all
write normally.

### `time` (default on)

Adds `current_time`, returning ISO 8601 plus the local string. Auto-approved; it reads
nothing. Useful because models are confidently wrong about the date.

### `bell` (opt in)

Writes `\u0007` to stderr when a turn ends. Off by default — a bell after every turn is
intrusive, but it is genuinely useful when a turn takes minutes.

```json
{ "plugins": ["guard", "secrets", "protect", "time", "bell"] }
```

## Writing one

A refusal rule is usually better as an installed manifest: no rebuild, and nothing to review.
See [registry](registry.md) for the manifest shape. Reach for a builtin only when the plugin
needs to contribute a tool or run something after a turn.

Builtin plugins live in `src/plugins-builtin.ts` and are registered in `BUILTIN_PLUGINS`.

```ts
export const noSecretsPlugin: Plugin = {
  name: 'no-secrets',
  description: 'refuses to write files that look like credentials',
  appendix:
    'The no-secrets plugin refuses writes to .env and credential files. Ask the user to ' +
    'add secrets themselves rather than working around it.',
  beforeToolCall: ({ toolName, input }) => {
    const WRITE_TOOLS = ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'move_file', 'delete_file'];
    if (!WRITE_TOOLS.includes(toolName)) return undefined;
    const path = String((input as { path?: unknown } | null)?.path ?? '');
    if (/(^|\/)\.env|credentials|\.pem$/.test(path)) {
      return `refusing to write ${path}; add secrets yourself`;
    }
    return undefined;
  },
};
```

Then add it to `BUILTIN_PLUGINS` and, if it should be on by default, `DEFAULT_ENABLED`.

Note the six tool names. Every write tool has to be listed, and `multi_edit`, `apply_patch`,
and `move_file` are all easy to miss — a guard that only checks `write_file` and `edit_file` is
bypassed by a batch edit, a patch, or a rename. `apply_patch` and `move_file` also carry their
paths somewhere other than `path`, so a guard reading only that field sees nothing to check.
The builtins share one `writtenPaths` helper for exactly that reason.

Write the `appendix` whenever the plugin can block something. Without it the model hits a
refusal it was never told about and tries to route around it.

## Ordering

Builtin plugins run first, in the order they are enabled, then installed ones. The first
`beforeToolCall` to block wins; later hooks are not consulted. `afterTurn` runs every hook, and
one throwing does not stop the rest.
