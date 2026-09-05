# Roadmap

What is built, what is next, and what has been deliberately declined. Reordered when
evidence says the order is wrong.

Nothing here is a date. Items move to [TODO.md](TODO.md) when they are next up.

---

## Shipped

### 0.1.0-beta.1

**Core loop** — `streamText` with tool approvals suspended and resumed through the SDK's
`toolApproval`, so a denied tool provably never executes. Endpoint fallback for OpenAI
reasoning models that reject function tools on `/v1/chat/completions`. Retry with backoff
for transient failures.

**Tools** — `read_file` `write_file` `edit_file` `glob` `grep` `bash`, all path-jailed to
the workspace. ripgrep bridge with a JavaScript fallback. `.gitignore` and `.shiroignore`
aware walking. Binary rejection. Live-streaming `bash` output.

**Interface** — Ink TUI with markdown rendering, slash command menu, readline input with
per-project prompt history, coloured diffs in approval prompts, and panels for tasks,
subagents, command output, questions, and command results.

**Agents** — five variants crossing thinking level with tool restrictions. `plan` and
`review` withhold mutating tools from the model rather than discouraging them.

**Skills** — frontmatter markdown, catalogue in the prompt and body on demand. Four bundled,
overridable per user and per project.

**Plugins** — tool contribution, auto-approval, `beforeToolCall` blocking, `afterTurn`
hooks, prompt appendices. `guard` refuses irreversible shell commands ahead of any approval,
including under `--yolo`.

**Memory and state** — durable per-project memory with hit-counted recall and model-driven
compaction. Session task lists with four states. Session persistence with resume. Context
compaction that repairs the provider-item dependencies pruning breaks.

**Subagents** — read-only `task` with `explore` and `review` flavours, progress streamed to
a panel.

**Asking** — the `ask` tool, withheld in headless runs rather than left to hang.

**MCP** — stdio and HTTP servers, tools namespaced `mcp__<server>__<tool>`, a failing server
reported rather than fatal.

**Distribution** — five-platform cross-compiled binaries, checksums, install scripts, CI on
three operating systems, tag-driven releases.

### 0.1.0-beta.3

Fourteen built-in tools, up from six, with sets so the schema cost stays controllable.

`v0.1.0-beta.2` was tagged and never published: `bun build --compile
--target=bun-windows-x64` rejects `--windows-title` unless the host is Windows, and CI
releases every target from one Ubuntu runner. It passed locally and failed on the last of
five builds. The version was burned rather than moving a published tag.

**Visible process** — reasoning streams to a collapsed panel with an estimated token count,
`ctrl-r` expands it, and it leaves with the turn since it is progress rather than the answer.
The tool in flight is named from `tool-input-start`, before its arguments have finished
streaming, and cleared on its result.

**Message queue** — the input stays mounted while the model works. A prompt typed mid-turn
queues, the panel counts what is waiting, and the queue drains in order when the turn ends.
`esc` clears the queue as well as aborting. Queued slash commands replay as if typed.

**More tools** — `multi_edit` applies several edits to one file atomically, validating every
edit in memory first so a late failure cannot leave the file half-written. `list_dir` gives an
ignore-aware depth-limited tree. Five read-only git tools, spawned with a fixed argv rather
than a shell string, which is what makes them safe to auto-approve.

**`activeTools` gating** — `toolSets` in config: `core` always on, `edit-plus` and `git`
optional. A disabled set reaches neither the wire nor the system prompt. `/tools` names the
set each live tool came from.

**Pruning correctness** — a tool result whose tool call the pruner discarded is now dropped
with it. Message-counted pruning cut between an assistant tool-call and the tool message
answering it, and the OpenAI responses API rejects the result on its own with 400 "No tool
call found for function call output with call_id ...".

**Batch reads** — `read_many_files` takes up to twenty paths, each with its own window, and
runs them concurrently. An unreadable path is reported in its own block rather than throwing,
so one wrong guess costs a line instead of the call.

**`@file` completion** — `@` opens a picker fed by the ignore-aware walker, narrowing as you
type. Prefix matches rank above substring matches, so `@src/` means "under src/" rather than
"anything containing src/". Tab inserts a plain relative path. The walk happens on the first
`@` rather than at startup.

**Interruptible commands** — `ctrl-c` kills the command in flight and keeps the turn: the call
fails with a message saying the command did not finish and its effects are unknown, and the
model takes its next step from there. The kill takes the whole process tree, because killing
`cmd /c` alone leaves the real command holding both pipes open and the read never returns.

### 0.1.0-beta.4

**Compaction no longer stops the loop.** The beta.2 repair dropped any assistant part whose
reasoning item pruning had removed. On a reasoning model that is every tool call, so past the
threshold the model could no longer see what it had already run — and re-ran it until the step
limit ended the turn. The fix strips the provider `itemId` rather than the part: without one the
same content is serialised inline instead of as an `item_reference`, so the dependency on the
pruned reasoning item disappears while the history survives. Compaction may shorten the
history; it must not blank it.

**Bounded compaction.** The fixed three-message tool window collapsed long transcripts to a
handful of messages — a 405-message run kept two of 202 tool calls. Pruning now drops
reasoning first and keeps the widest recent tool tail that fits a ladder, and the SDK's
step-to-step message carry-over does the rest: the model keeps its record of what it ran. The
turn reports one compaction event rather than one per step.

**External registry.** `/registry` browses, searches, installs, and removes skills and plugins
from an index over https. The two kinds are treated differently on purpose: a skill is prompt
text and is shown in full before it joins your system prompt, while a plugin is a validated
manifest of deny rules that the compiled guard evaluates. Loading code from a URL is declined
outright — a plugin that could block tool calls could otherwise lie about blocking them.

**Interface.** Context shown as a percentage of the compaction threshold, amber from two
thirds and red at 90, so a turn about to lose history says so first. Aligned command menu and
registry tables, and `/skills` and `/plugins` name the origin of every entry. Tool calls show
their load-bearing arguments — the paths a batch read is about to pull in, the files a patch
touches — and each result line carries an outcome summary.

**Permission rules.** Approval moved from a list of tool names to rules matched against the
call's subject: the command for `bash`, the path for a file tool. `bash` used to be a single
yes/no covering `git status` and `rm -rf`, so a user pressing `a` once during a batch removed the
gate for both — the check was strongest when it mattered least. Rules let `git *` run while
everything else asks, `always` grants the pattern rather than the tool, `.env` and `.pem` are
refused on read outright, and a call repeated identically three times in one turn asks even when
allowed. `--yolo` folds `ask` into `allow` and still cannot reach a deny rule or the guard.

Surveyed Claude Code, Codex, opencode, and phi before writing it. Three of the four had already
moved to per-pattern rules; the shape here is closest to opencode's, with the credential deny and
the repeat guard taken from it directly.

**`apply_patch`.** One atomic patch across files — add, update, move, delete — validated in
full before anything is written, so a failure on the fourth file leaves the first three
untouched. Permission rules match every path the patch touches, so denying `src/generated/*`
catches a patch that includes one among five files.

**`web_fetch`.** URL to markdown, size-capped, in a `net` tool set that is off unless asked
for — it is the one tool that leaves the machine. HTTPS is required for public hosts, private
and loopback addresses are refused, and redirects are re-checked one hop at a time so a public
URL cannot redirect into the cloud metadata endpoint.

**Writable worker subagents.** `task` gains a `worker` kind that holds the write tools and
routes every write and command through the parent's approval gate — the same rules, the same
prompt, the same session grants as a direct call. Without an approval channel the worker kind
is not offered at all rather than silently downgraded to read-only. `explore` and `review`
stay structurally read-only, and no subagent holds `web_fetch`.

---

### 0.1.0-beta.5

**A dead provider item no longer ends the turn.** An `item_reference` resolves only while the
provider still stores that item, so a resumed session — or one that fell back to `/v1/responses`
mid-turn — could fail with 404 "Item with id 'msg_...' not found" on every attempt, since every
retry sent the same reference. Compaction now strips every provider `itemId` from what it sends,
and a 404 naming a missing item rewrites the session's history inline and runs the request again,
once per turn and only before any output has been delivered.

**Interface.** Context shows the elapsed working time and a compaction warning as the threshold
approaches, diff lines are numbered, markdown task lists render, the prompt edits by word and
`ctrl-d` deletes to the end of line, and a farewell tells you how to resume the session.

**More tools.** `git_commit_message` writes a commit message from the staged diff and the
repository's own recent subjects, in one nested model call — it never commits, so it needs no
approval. `move_file` and `delete_file` fill the gap that made every rename a write-then-delete
pair: both are gated, `move_file` matches permission rules at both ends, and `delete_file`
refuses a directory because removing a tree is what the guard blocks in `bash`. `git_branch`
lists branches with the current one marked.

**More plugins.** `protect` refuses writes to `.git`, lockfiles, `node_modules`, vendored code,
and build output — files a tool owns rather than a person, where an edit leaves a repository
that looks fine and behaves wrongly. It ships on, alongside `guard` and `secrets`, and every
path-based guard now shares one helper that understands where each write tool keeps its paths.

**More skills.** `security` (trust boundaries, then injection, authorisation, traversal, SSRF),
`perf` (measure, locate, one change, stop at a target), and `migrate` (changelog first, every
call site before one edit, never hand-merge a lockfile) join the bundled set.

**The MCP panel.** `/mcp add` walks through a local or remote server — kind, name, command and
arguments or URL and headers — validating the name against the `mcp__<server>__<tool>`
namespace as it is typed rather than failing at connect. `/mcp` lists what is configured with
each server's live tool count or its connection error, and `/mcp remove` takes one out. All
three write `config.json` directly; a new server connects on the next start, because
connecting mid-turn would change the tool list under a running request.

---

## Next

### MCP without the schema tax

Every MCP tool's schema is in the prompt on every request, and `toolSets` does not gate them: a
twenty-tool server costs roughly 2,750 tokens a turn whether the model touches it or not. phi's
answer is three meta-tools — `mcp_list`, `mcp_inspect`, `mcp_call` — with the prompt naming only
the servers, so a hundred servers cost almost nothing until one is called. Worth keeping direct
registration as an option: for a two-tool server the indirection is the more expensive of the two.

### Custom commands from a file

A markdown file becoming a slash command, with `$ARGUMENTS`, `$1`, `` !`cmd` `` for shell output,
and `@path` for a file. Every comparable CLI has this and none of it is hard; it is missing because
nothing forced the issue.

### Undo a turn

opencode has `/undo` and `/redo`, Claude Code has `/rewind` over file checkpoints. There is
`/resume` here, which restores a whole session, and nothing that steps one turn back. The honest
limit is the same for everyone: a `bash` command's effects cannot be snapshotted, so this covers
file-tool edits and says so.

### Lossless-enough compaction

Compaction keeps the model's memory of a turn now, but it still says nothing about the messages it
discarded, so the model can contradict its own earlier decision with confidence. A summary of the
discarded span costs one cheap call and removes the whole class of problem.

### Cost control

Two halves of the same problem: an `explore` subagent pays the parent's reasoning rate for
what is really a search, and nothing stops a headless run that loops. A cheaper subagent model
and a per-session ceiling are both small changes on top of the pricing that already exists.

### Derived tool metadata

`TOOL_SETS` and `MUTATING_TOOLS` are hand-maintained lists of tool names. A tool added to one
and forgotten in the other is a silently ungated write. Marking each tool where it is defined,
and checking the coverage in the suite, removes the failure mode rather than documenting it.

### Registry trust

An index is trusted for its contents, not its authorship: `registryUrl` is the whole trust
decision, and there are no signatures. Publisher keys and a pinned digest per entry would make
"install this skill" a decision about a specific artifact rather than about a URL.

### `web_fetch`

Shipped in beta.4 — see above. What remains declined: wrappers around a single bash line with
no added guarantee. `run_tests`, `typecheck`, `lint`, `build` are five tools of pure schema tax
when the real commands are already in `AGENTS.md`.

---

## Later

**Subagent parallelism.** Two independent searches run sequentially today. The panel already
handles multiple agents; the loop does not fan out.

**Session branching.** Fork a session at a message to try a different approach without
losing the original.

**Structured diff review.** Approve or reject individual hunks of an `edit_file` call rather
than the whole thing.

**Plugin code from disk.** Declarative manifests ship in beta.4, and that is the whole of it
for now. Loading `.shiro/plugins/*.ts` needs a sandbox story first — a plugin that can block
tool calls can also lie about blocking them, and one that can execute can read whatever the
agent can read.

**Prompt caching.** Anthropic and OpenAI both support it. The system prompt is rebuilt every
step for task-list freshness, which defeats a naive cache; splitting the stable prefix from
the volatile suffix would fix that.

**External hooks.** phi and both first-party CLIs let a script sit in the tool loop: a directory
with a manifest and an executable, one JSON object in on stdin, one out. phi's `pre_tool` can
rewrite the tool's input as well as allow or deny, which the compiled plugin interface here cannot
express. The reason it is here rather than in Next is that it needs a trust story — Codex hashes
each hook and refuses to run one until you review it, which is the right shape and more work than
the feature.

**OS-level sandboxing.** The strongest thing in this class, and Codex is the one that has it:
Seatbelt on macOS, Landlock and seccomp on Linux, a separate mechanism on Windows, with network
egress governed by domain rules. Permission rules gate the *call*; a sandbox governs what the
process can then reach. Three platform-specific implementations, and OpenAI moved Codex to Rust
partly for this. A half-built sandbox is worse than none, because people would trust it.

---

## Declined

**A web UI.** This is a terminal tool. A browser front end doubles the surface area and
serves a different product.

**Model-agnostic prompt tuning.** Per-model prompt variants are a maintenance treadmill for
gains that evaporate on the next model release.

**Auto-commit.** The agent should never write git history without being asked. Commits are
the user's record of their own work.

**Vector search over the codebase.** ripgrep answers a scoped question in 135 ms with no
index to build, invalidate, or ship. An embedding store is a large amount of machinery for a
worse answer on a codebase that fits in a grep.

**Tool call retries on model error.** A model that produced a malformed call will usually
produce it again. Surfacing the error teaches it more than a silent retry.

**A client/server split.** opencode runs a server and treats its TUI as one client of an OpenAPI
endpoint, which is what lets IDE extensions and a web client exist. It is the right architecture
for that product. Here it would add a protocol, a port, and an auth story to serve a second client
nobody has asked for.

**LSP integration.** opencode ships it and its own documentation says the honest thing:
*"not always a net positive... in many projects it is better to have the agent run lint, typecheck,
or other diagnostic CLI tools directly."* Language servers drift out of sync, use real memory, and
vary by version. `bash bun run typecheck` puts the same errors in front of the model with none of
that, and `AGENTS.md` is where the command belongs.
