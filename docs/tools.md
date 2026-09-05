# Tools

## The approval model

Every call resolves to `allow`, `ask`, or `deny` through a rule matched against the call's
subject — the command for `bash`, the path for a file tool. [Permissions](permissions.md) is the
full reference; the short version:

**Allowed by default.** Read-only tools and anything touching the agent's own state:
`read_file`, `read_many_files`, `glob`, `grep`, `list_dir`, `task`, the whole git set,
`todo_write`, `remember`, `recall`, `forget`, `skill`, `ask`, and anything a plugin marks
auto-approved.

**Denied by default.** `*.env`, `*.env.*`, and `*.pem` on read. Not gated, refused: a secret that
reaches the context is on the wire and in the session file, and there is no taking it back.
`*.env.example` is allowed.

**Asked by default.** `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `move_file`,
`delete_file`, `bash`, `web_fetch`, and every `mcp__*` tool.

```
bash wants to run
git status --porcelain
y allow once | a always allow bash git * | n deny
```

`a` whitelists the **pattern**, not the tool: approving `git status` runs `git log` unprompted and
still asks about `npm publish`. `n` tells the model it was denied and to ask what to do instead.

A rule turns the common cases off entirely:

```json
{ "permission": { "bash": { "*": "ask", "git *": "allow", "bun test*": "allow" } } }
```

Three more things sit around the rules:

- **The guard plugin refuses first.** It is not an approval, and `--yolo` does not reach it. See
  [plugins](plugins.md).
- **A repeated call asks anyway.** The same tool with identical input three times in one turn stops
  for approval even when allowed — a model repeating itself is not making progress.
- **The SDK enforces the decision.** A denied call provably never executes, because the SDK never
  reaches the tool's `execute`. A tool cannot forget to honour a denial. See
  [architecture](architecture.md#why-approval-goes-through-the-sdk).

## Tool sets

Each tool costs its name, its description, and its JSON schema on **every request**. The current
registry has nineteen built-ins. `/tools` shows the live set; disabling an optional set removes
its schemas from both the request and the system prompt.

| Tool | Bytes | Tool | Bytes |
|---|---|---|---|
| `read_many_files` | 972 | `git_blame` | 499 |
| `multi_edit` | 934 | `git_log` | 484 |
| `edit_file` | 618 | `git_diff` | 473 |
| `grep` | 595 | `bash` | 466 |
| `list_dir` | 594 | `git_show` | 432 |
| `read_file` | 526 | `git_status` | 292 |
| `glob` | 499 | `write_file` | 289 |

Selection accuracy also falls as the list grows: a model choosing between six tools picks better
than one choosing between twenty.

Sets let you switch off what a project does not need:

| Set | Tools | Cost |
|---|---|---|
| `core` | `read_file` `write_file` `edit_file` `glob` `grep` `bash` | ~2,993 B |
| `edit-plus` | `multi_edit` `list_dir` `read_many_files` `apply_patch` `move_file` `delete_file` | patch and file ops |
| `git` | `git_status` `git_diff` `git_log` `git_show` `git_blame` `git_branch` `git_commit_message` | ~2,180 B + message |
| `net` | `web_fetch` | opt in |

```json
{ "toolSets": ["edit-plus"] }
```

Omit `toolSets` for the default sets. Add `net` when the agent should fetch public pages.
`core` is always on — without read, edit, and bash the agent is not an agent. A disabled set reaches neither the wire nor the system prompt, since
a prompt that names an absent tool teaches the model to attempt calls that cannot succeed.
Session, plugin, and MCP tools are not part of this budget and are never gated here.

An unrecognised set name is dropped silently. The header line at startup shows which sets
actually loaded, so a typo reads as "that set is off" rather than as an error — worth checking
if a tool you expected is missing.

`/tools` shows which set each live tool came from:

```
tools
20 offered this turn of 22 registered
- `bash`             core
- `git_diff`         git
- `list_dir`         edit-plus
- `remember`
```

A tool with no set is a session, plugin, or MCP tool.

### Which sets to keep

Both extra sets earn their place in most projects, but not all:

- **No git in the repo?** `git` is 2,180 bytes the model can never use. Switch it off.
- **A model that handles many tools badly?** `{ "toolSets": [] }` trims to six, which is the
  smallest set that still lets the agent work.
- **Reading a lot, editing rarely?** Keep `edit-plus` for `list_dir` and `read_many_files`
  alone; they pay for themselves in round trips saved.

## File tools

### `read_file`

```
path    file path relative to the workspace root
offset  first line, 1-based
limit   max lines, default 2000
```

Returns contents with 1-based line numbers. Refuses binaries: a NUL byte in the first 8 KB
means the file is not text, and a model that reads a 90 MB executable has burned its whole
context on nothing.

### `read_many_files`

```
files  [{ path, offset?, limit? }], at most 20
```

One round trip for several files, each with its own window. Reads run concurrently and the
blocks come back in the order given, labelled:

```
===== src/app.ts =====
1: export const port = 8080;

===== src/gone.ts =====
[unreadable: No such file: src/gone.ts]
```

A path that cannot be read is reported in its own block rather than throwing, so one wrong
guess costs a line instead of the whole call. Numbering and binary refusal are the same code
path as `read_file`, so a batch read cannot drift from a single one.

### `write_file`

```
path     file path
content  full contents
```

New files and full rewrites only. Creates parent directories.

A rewrite that collapses whitespace is flagged in the result: similar character count,
a fraction of the lines. A model writing a large file under output pressure squeezes
newlines and indentation before it cuts markup — the bytes survive, the layout does not —
so the result names the collapse and the turn fixes it in place:

```
Wrote 139 chars to index.blade.php, but it collapsed 9 lines into 1. If that was not
intended, re-send the content with its original newlines and indentation.
```

### `edit_file`

```
path        file path
oldString   exact text to find, whitespace and indentation included
newString   replacement
replaceAll  replace every occurrence instead of requiring exactly one
```

`oldString` must match byte-for-byte and appear exactly once unless `replaceAll` is set.
An ambiguous match is an error naming the count, which pushes the model to add surrounding
context rather than guessing which occurrence it meant:

```
oldString appears 3 times in src/users.ts. Add surrounding context or set replaceAll.
```

That error is deliberately specific. `edit failed` would leave the model to retry blind; the
count tells it what to do next.

### `multi_edit`

```
path   file path
edits  [{ oldString, newString, replaceAll? }], in the order to apply them
```

Several edits to one file in one call, one approval, one write. Each edit sees the result of
the previous one, so edits may build on each other.

Atomic: every edit is validated and applied in memory first, so a failure on the third edit
leaves the file exactly as it was rather than half-changed. The same uniqueness rule as
`edit_file` applies per edit, and the error names which edit failed:

```
edit 2: oldString not found in src/users.ts. No edits were applied.
```

The last sentence matters. Without it a model reading the error has to guess whether edit 1
landed, and its next move — retry the whole batch, or only what failed — depends on the answer.

### `apply_patch`

```
patch  one envelope containing Add, Update, Move, and Delete file markers
```

All operations are validated before anything is written, so a failure leaves every file
unchanged. Use it when one change spans files that must land together; use `multi_edit` for
several edits to one file and `edit_file` for one edit. Paths stay inside the workspace and the
call asks for approval.

### `move_file`

```
from  existing file path
to    new path, including the filename
```

Renames or relocates one file, creating the target directory. Refuses a missing source and an
occupied target, so a rename cannot silently overwrite work. Permission rules match **both**
ends, so denying `src/generated/*` catches a move that lands there as well as one that starts
there.

For a rename plus its callers in one atomic step, `apply_patch` is the better tool: it lands
the move and the edits together or not at all.

### `delete_file`

```
path  file to delete
```

Deletes one file and reports its size. A directory is refused: removing a tree is exactly what
the guard plugin blocks in `bash`, and it is not something to do implicitly through a tool
whose name says "file". Delete the files you mean, one call each.

### `list_dir`

```
path            directory, relative to the workspace root, default the root
depth           levels to descend, 1-6, default 2
includeIgnored  also show files git ignores
```

Tree view honouring `.gitignore`. Directories end with `/`, files show their size:

```
.
README.md  2B
src/
  app.ts  2K
  ui/
```

Past the depth limit the containing directory is still listed, so the shape of the tree stays
visible without its contents — `src/ui/` above appears at `depth: 2` even though its files do
not. Capped at 300 entries.

### `glob`

```
pattern         e.g. "src/**/*.ts"
limit           max paths, default 200
includeIgnored  also return files git ignores
```

Walks the tree honouring `.gitignore` and `.shiroignore`, skipping `.git` and
`node_modules` unconditionally. Nested ignore files apply only within their own directory,
as git does. Returns posix paths relative to the workspace root.

A symlinked directory is classified as a directory and not descended into. Both halves matter:
`readdir` reports a junction as a non-directory, so without the extra `stat` a symlinked
directory leaked past `dir/` ignore rules and was yielded as a file with a nonsense size. Not
descending is separate — a link can point anywhere, including back into the tree.

### `grep`

```
pattern         regex source
include         glob limiting the search, default "**/*"
ignoreCase      case-insensitive
includeIgnored  also search files git ignores
```

Shells out to ripgrep when it is on PATH — roughly 15x faster on a real repo — and falls
back to a JavaScript walker otherwise. Output is `path:line: text` either way, so the model
sees one format regardless. Skips binaries. Caps at 200 hits.

Two details keep the two paths in agreement. ripgrep is passed `--no-require-git`, because it
otherwise ignores `.gitignore` outside a repository while the JavaScript fallback always honours
it. And an rg exit code above 1 means rg could not run the search at all, so the fallback takes
over; exit 1 is simply "no matches" and is reported as such.

Regex syntax differs between the two: ripgrep is Rust regex, the fallback is JavaScript. A
pattern using look-around works in the fallback and fails under rg. An invalid pattern is
reported as `Invalid regex: <reason>` rather than returning an empty result set.

### `bash`

```
command  shell command
timeout  ms, default 120000, max 600000
```

Runs in the workspace root through `bash -lc` or `cmd /c`. Output streams live to the panel
above the input rather than appearing all at once when the command exits — a two-minute test
run is otherwise indistinguishable from a hang. Both pipes are drained concurrently, since a
command that fills one while you block on the other deadlocks.

Returns exit code, stdout, stderr, and a note if a signal killed it.

**`ctrl-c` interrupts the command, not the turn.** The shell and everything it started are
killed — on Windows through `taskkill /T`, because killing `cmd` alone leaves the real command
holding both pipes open and the read never ends. The call then fails rather than returning,
so the model cannot mistake a killed command for one that ran and failed on its own:

```
The user interrupted this command. It did not finish, so its effects are unknown.
stdout:
[whatever it printed first]
```

The turn continues from there. `esc` still aborts everything, and `ctrl-c` with nothing
running quits as usual.

## `web_fetch`

```
url       absolute HTTP(S) URL
maxChars  returned characters, default 30,000, max 30,000
```

Fetches a public text page and converts HTML to markdown. HTTPS is required for public hosts;
private and loopback addresses are refused, redirects are checked one hop at a time, and the
body is capped. The result is untrusted page content, not an instruction, and the call asks for
approval. It belongs to the opt-in `net` set.

## Git tools

All five are read-only and therefore approval-free. Each spawns `git` with a fixed argument
array rather than a shell string, so an argument like `--author="; rm -rf /"` can only ever
be a literal argument — which is what makes auto-approval safe. A test asserts exactly that:
`git_log` with the path `; touch pwned.txt` creates no file.

Output is described rather than raw porcelain. `git_status` names the branch and says
`staged modified` or `untracked` per file instead of leaving the model to decode porcelain's two
leading columns:

```
On main, 2 changed:
src/app.ts  (staged modified, modified)
new.ts  (untracked)
```

That file has a staged change *and* a later unstaged one, which the raw `MM` prefix conveys only
to a reader who knows the format.

Outside a repository they fail with `<cwd> is not a git repository.` rather than passing git's
own error text through. Other git failures do pass through, on purpose: `git_show no-such-ref`
reports what git said, because git's own message is the most useful thing available.

```
git_status                                  branch, staged, modified, untracked
git_diff    staged?  path?                  unified diff of uncommitted changes
git_log     limit?   path?                  hash, date, author, subject; newest first
git_show    ref      path?                  one commit: message, author, diff
git_blame   path     startLine?  endLine?   who last changed each line
git_branch  remote?                         branches, newest commit first, current marked
```

### `git_commit_message`

Generates one commit message from the staged changes. The nested model call sees two
things: the staged diff, and the fifteen most recent commit subjects, because a message
that ignores the repository's established style reads as foreign however accurate it is.
An oversized diff is truncated before it reaches the model.

It never commits — it returns the message only, approval-free, because generating text
cannot mutate anything. Running the commit stays on the gated `bash` path, where the
user sees the message and the command together.

```
$ git_commit_message
bump the server port to 9090
```

Nothing staged is a stated error rather than an empty message, so the model's next move
is to stage, not to guess.

`git_log` defaults to 15 commits and caps at 40. `git_blame` without a range blames the whole
file; with `startLine` and no `endLine` it covers 40 lines from there. `git_branch` sorts by
last commit and marks the current branch with `*`, which is what makes an already-taken branch
name obvious before proposing one.

Everything here is also reachable through `bash`. The reason the set exists anyway is the
approval boundary: `bash git diff` stops for a decision on every call, while `git_diff` cannot
mutate anything and so never needs one.

## Agent tools

### `task`

```
description  short label shown to you
prompt       self-contained instructions
kind         "explore" (default), "review", or "worker"
```

Spawns a subagent with its own context window. It returns one report, so the parent pays for
the findings rather than the whole search transcript, and it sees none of the parent
conversation, so its prompt has to stand alone.

`explore` finds and reports; `review` critiques code in severity order. Both are structurally
read-only — they hold no gated tool at all, so they cannot trigger an approval prompt whatever
the config says. The parent's context holds the conclusion instead of the search: a subagent
reading forty files to answer one question costs the parent the answer, not the forty files.

`worker` holds the write tools as well, and every write and command routes through the
parent's approval gate — the same rules and the same prompt as a direct call. The full
delegation trade-offs are in [agents](agents.md#delegating-with-task).

Progress streams to the subagent panel, with each call's outcome. Capped at 20 steps, and it
shares the parent's model — an `explore` run pays reasoning rates for what is really a search,
which is [on the list](../TODO.md) to fix.

Not worth delegating a single grep: the subagent is a whole extra model loop, so it wins on a
search spanning many files and loses on anything you could answer in one call.

### `ask`

```
question  one specific question
options   choices, recommendation first, each with an optional detail
multiple  allow more than one
```

Stops the turn and puts the question on screen. With options it is a picker; without, free
text. `esc` skips, which returns "the user dismissed this; use your best judgement" — so a
dismissal is an instruction to decide, not a dead end.

Withheld entirely in headless mode — a question with no one to answer it would hang. The system
prompt says so, and tells the model to decide and state its assumption instead.

### `todo_write`

```
todos  the complete list: content, status, optional note
```

Statuses: `pending`, `in_progress`, `done`, `blocked`. Send the whole list each time; it
replaces the previous one. Warns when more than one task is `in_progress`, when nothing is
`in_progress` while work remains, or when a `blocked` task has no note.

The list lives in the system prompt, rebuilt every step, so it survives both pruning and
`/compact`. See [memory](memory.md).

### `remember`, `recall`, `forget`

Durable per-project notes. See [memory](memory.md).

### `skill`

```
name  skill name from the catalogue
```

Loads the body of a skill. See [skills](skills.md).

## Path safety

Every path a tool receives goes through a jail: resolved against the workspace root, then
checked that it did not escape.

```ts
export function jail(p: string, root = process.cwd()): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
  return abs;
}
```

`../../etc/passwd`, `a/../../secret`, and absolute paths outside the root are all refused
before any filesystem call. Resolving first and comparing after is what catches the middle
case: string-prefix checks on the raw input miss `a/../../secret` entirely.

The model's output is a trust boundary. It can emit any string, so the check happens on
every call rather than being assumed. That includes `read_many_files`, where a bad path is
reported in its block like any other unreadable file.

`jail` guards the workspace, not the shell. `bash` runs whatever it is given, which is why
every call needs approval and why the guard plugin exists — see [plugins](plugins.md).

## Output caps

Any single tool result is truncated at 30,000 characters with a note saying how much was cut:

```
... [truncated 41,233 chars]
```

| Tool | Cap |
|---|---|
| any result | 30,000 characters |
| `grep` | 200 hits, each line cut at 300 chars |
| `glob` | 200 paths |
| `list_dir` | 300 entries |
| `read_many_files` | 20 files |
| `read_file` | 2,000 lines by default |
| `bash` | 120 s default timeout, 600 s max |

Without caps one `grep` for `function` can end a session. The caps are per call, so a model
that needs more can narrow and ask again — which is cheaper than one call that fills the
context and forces compaction.
