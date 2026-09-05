# Permissions

Which tool calls run, which stop to ask, and which are refused.

```json
{
  "permission": {
    "bash": { "*": "ask", "git *": "allow", "bun test": "allow" },
    "edit_file": { "*": "ask", "src/generated/*": "deny" },
    "read_file": { "*": "allow", "*.env": "deny" }
  }
}
```

Three decisions: `allow` runs it, `ask` prompts, `deny` refuses without asking.

## Why rules match the command, not the tool

The obvious design gates by tool name: `bash` needs approval, `read_file` does not. That is what
this used to do, and it fails for a reason worth stating.

`bash` covers `git status` and `rm -rf` equally. A user working through a batch of edits presses
`a` — always allow — on the first prompt, and every later command runs unasked, including the one
they would have refused. The gate was strongest at the moment it mattered least and gone by the
time it mattered.

Rules match the **subject** of a call: the command for `bash`, the path for anything touching a
file, the pattern for a search. `git *` can be allowed while `*` still asks, so the prompts that
remain are the ones worth reading.

## Subjects per tool

| Tool | Matched against |
|---|---|
| `bash` | the command, e.g. `git status --porcelain` |
| `read_file` `write_file` `edit_file` `multi_edit` `delete_file` `list_dir` | the path |
| `move_file` | both ends; one match is enough |
| `apply_patch` | every file marker path in the patch |
| `web_fetch` | the URL |
| `read_many_files` | every path in the batch; one match is enough |
| `glob` `grep` | the pattern |
| `git_diff` `git_log` `git_blame` | the path, when given |
| `git_show` | the ref |
| `task` | the subagent description |
| `skill` | the skill name |
| everything else | `*` only |

A tool with no subject — `git_status` takes no arguments — matches `*` and nothing narrower. That
is why a rule for it is a plain decision rather than a pattern table:

```json
{ "permission": { "git_status": "allow" } }
```

## Patterns

`*` spans any characters including newlines, `?` matches exactly one. Everything else is literal:
`*.env` does not match `configxenv`, because a rule you wrote by hand should mean what it looks
like.

Newlines matter for `bash`, where a command can legitimately contain one:

```json
{ "permission": { "bash": { "git commit *": "allow" } } }
```

That still matches `git commit -m "line one\nline two"`.

## Order is the whole rule

Later rules win. A config reads top to bottom, so put the catch-all first and narrow after it:

```json
{ "permission": { "bash": { "*": "ask", "git *": "allow", "git push *": "ask" } } }
```

`git status` is allowed, `git push origin main` asks again. Reverse those last two and `git push`
is allowed, because the broader rule now comes last.

This is plain precedence with no special case for `deny`, and that is deliberate. An earlier
version made `deny` win wherever it sat, on the theory that a refusal should be impossible to
undo by accident. It made the most useful shape in the system unexpressible:

```json
{ "permission": { "edit_file": { "*": "deny", "src/generated/*": "allow" } } }
```

Default-deny with narrow exceptions is what a careful user writes, and it is the same shape as
`*.env` denied while `*.env.example` is allowed. Refusals that must never be configurable belong
in the [guard plugin](plugins.md), which runs ahead of this and which `--yolo` cannot reach.

## Defaults

With no `permission` config:

| Tool | Default |
|---|---|
| `read_file` `read_many_files` | `allow`, except `*.env`, `*.env.*`, and `*.pem` which are `deny`. `*.env.example` is allowed |
| `glob` `grep` `list_dir` | `allow` |
| the git tools | `allow` — they cannot mutate anything |
| `task`, and every session tool | `allow` — they touch the agent's own state |
| `write_file` `edit_file` `multi_edit` `apply_patch` `move_file` `delete_file` `bash` `web_fetch` | `ask` |
| anything else, including every `mcp__*` tool | `ask` |

Credentials are denied on read rather than gated, because there is no recovery. A model that
greps for a config value and finds a secret has that secret in its context, on the wire, and in
the session file on disk. `.env.example` is the one such file that is safe and the one a model
usually wants.

An unrecognised tool asks. MCP tools are third-party code with unknown side effects, so
`mcp__fs__read_file` sounding harmless is not a reason to let it through.

## Config replaces a default, it does not merge

Anything you say about a tool replaces its default for that tool entirely:

```json
{ "permission": { "read_file": { "*": "allow" } } }
```

That allows reading `.env`. Merging pattern-by-pattern would leave you unable to remove a default
deny rule, and a safety feature you cannot switch off is one people work around instead.

A wildcard in a tool key covers a family:

```json
{ "permission": { "mcp__*": "deny" } }
```

## What `always` grants

Answering `a` at a prompt whitelists a **pattern**, not the tool. For `bash` that is the command's
first word:

```
bash wants to run
git status --porcelain
y allow once | a always allow bash git * | n deny
```

Approving that runs `git log` and `git diff` unprompted for the rest of the session, and still
asks about `npm publish`. Everything else falls back to `*`, because a path pattern guessed from
one path is more often wrong than useful.

Grants last for the session and are never written to disk. They also cannot outrank a rule: with
`"rm *": "deny"` in your config, `a` on a different command does not unlock `rm`.

## The repeat guard

A tool called three times in one turn with **identical** input asks for approval even when the
rules allow it:

```
read_file is repeating the same call
allowed by the rules, but this is the third identical call this turn
src/session.ts
```

A model repeating an identical call is not making progress: either it is ignoring the result, or
the result is not what it needed. `bash: allow` is a statement about which commands are safe, not
permission to run one in a loop until the step limit ends the turn.

The count is per turn and resets on the next prompt, so a tool used once in each of several turns
never trips it.

## Order of checks

```
guard plugin        refusal; --yolo cannot reach it
  → permission rules   allow / ask / deny, matched on the subject
    → repeat guard       an allowed call that has now repeated 3x asks anyway
      → the tool runs
```

A denied call **provably never executes**: the decision is enforced by the SDK, which never
reaches the tool's `execute`. A tool cannot forget to honour a denial because the tool is not
consulted. See [architecture](architecture.md#why-approval-goes-through-the-sdk).

## `--yolo`

Folds `ask` into `allow`. It does not touch `deny`, from your config or from the defaults, and it
does not reach the guard plugin. So `--yolo` still refuses to read `.env` and still refuses
`rm -rf`.

In headless mode there is no terminal to prompt on, so an `ask` is denied and the model is told.
`--yolo` is what makes a headless run able to write. See [headless](headless.md).

## A typo never widens access

An unrecognised decision string is dropped when the config is parsed, which leaves the pattern
unmatched and the tool on its default:

```json
{ "permission": { "bash": { "*": "alow" } } }
```

`bash` asks, as it would with no config at all. The alternative — treating an unparseable value as
`allow` — would mean one misspelling silently removing the gate.

## Worked examples

**Trust the tools you run constantly, keep the rest gated.**

```json
{
  "permission": {
    "bash": {
      "*": "ask",
      "git status*": "allow",
      "git diff*": "allow",
      "git log*": "allow",
      "bun test*": "allow",
      "bun run typecheck": "allow"
    }
  }
}
```

**Let it edit source, never touch generated output or CI config.**

```json
{
  "permission": {
    "edit_file": { "*": "ask", "src/*": "allow", "src/generated/*": "deny", ".github/*": "deny" },
    "write_file": { "*": "ask", "src/generated/*": "deny", ".github/*": "deny" }
  }
}
```

**Read-only, enforced by rules rather than by asking.** The `plan` agent variant does this by
withholding the tools, which is stronger; use rules when you want the tools present but inert.

```json
{ "permission": { "write_file": "deny", "edit_file": "deny", "multi_edit": "deny", "apply_patch": "deny", "bash": "deny" } }
```

**An unattended job that may commit but never push.**

```json
{
  "permission": {
    "bash": { "*": "deny", "git add *": "allow", "git commit *": "allow", "bun test*": "allow" }
  }
}
```

## What this is not

Rules gate the *call*, not what the command does once it runs. `bash` with `git *` allowed will
run `git config --global` and a `git` alias that shells out to anything. There is no sandbox: no
`seccomp`, no Seatbelt, no filesystem jail around the shell.

`jail()` keeps the **file tools** inside the workspace — see
[tools](tools.md#path-safety) — and the guard plugin refuses a list of irreversible commands. Both
are worth having and neither is containment. Run the agent in a container or a VM when the
workspace is not the trust boundary.
