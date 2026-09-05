# TODO

Next up. One item, one outcome, verifiable when done.

Longer-term direction lives in [ROADMAP.md](ROADMAP.md).

---

## Now

### Summarize the pruned span

Compaction now keeps the model's memory of a turn, but it still tells the model nothing about
the messages it dropped, so a decision from forty messages ago can be contradicted with
confidence.

- [ ] Summarize the discarded messages before dropping them
- [ ] Inject the summary in place of the count
- [ ] Budget it: a summary that grows with the session defeats the point
- [ ] Test: a pruned decision is still recoverable from the summary

### A spend ceiling

A headless run that loops costs real money with nothing to stop it.

- [ ] `maxSpendUsd` in config, checked after every turn
- [ ] Warn at 80%, refuse to start another turn at 100%
- [ ] Headless exits non-zero with the ceiling named, rather than stopping silently
- [ ] Test: a session past its ceiling refuses the next turn and says why

### A cheaper model for subagents

The subagent shares the parent's model. An `explore` run is search, not reasoning, and it
currently pays the parent's per-token rate.

- [ ] `subagentModel` in config, defaulting to the parent
- [ ] `/cost` separates parent from subagent spend
- [ ] Test: the subagent's calls go to the configured model, the parent's do not

### Hot-reload an installed entry

`/registry add` writes the file and says to restart. The skill catalogue and the guard chain
are both assembled at boot, so a mid-session install does nothing until then.

- [ ] Rebuild the skill list and plugin host after an install or removal
- [ ] Leave a turn in flight alone: its rules must not change underneath it
- [ ] Test: a skill installed mid-session is callable in the next turn without a restart

---

## Next

### MCP without the schema tax

Every MCP tool's schema goes into the prompt today, so twenty tools from one server cost roughly
2,750 tokens per request whether the model uses them or not. `toolSets` does not gate them.

phi solves this with three meta-tools — `mcp_list`, `mcp_inspect`, `mcp_call` — and a prompt that
names only the servers. A hundred servers then cost almost nothing until one is called.

- [ ] `mcp_list` / `mcp_inspect` / `mcp_call` replacing per-tool registration
- [ ] The prompt lists server names, not schemas
- [ ] Calls go through the same permission rules and guard as a built-in
- [ ] Keep per-tool registration as an option: a two-tool server is cheaper registered directly
- [ ] Test: a configured server contributes no schema to the request until `mcp_call`

### Custom commands from a file

Every other CLI in this class has these and they are cheap: a markdown file becomes a slash
command, with `$ARGUMENTS`, `$1`, `` !`cmd` `` for shell output, and `@path` for a file.

- [ ] `.shiro/commands/*.md` and `~/.shiro-neko/commands/*.md`, name from the filename
- [ ] Frontmatter for `description` and `agent`
- [ ] `$ARGUMENTS` and positional `$1`
- [ ] `` !`cmd` `` substituted before the prompt is sent, with the guard applied to it
- [ ] Test: a command with a shell substitution reaches the model with the output inlined

### Derive the tool-name lists

`TOOL_SETS` and `MUTATING_TOOLS` both list names by hand. A tool added to one and forgotten
in the other is a silently ungated write, which is the worst kind of bug this codebase can
have.

- [ ] Mark each tool as mutating where it is defined, not in a list beside it
- [ ] `TOOL_SETS` covers every registered tool, checked rather than assumed
- [ ] Test: a tool in no set, or a mutating tool outside `MUTATING_TOOLS`, fails the suite

### Subagent parallelism

Two independent searches run sequentially. The panel already renders several agents; the loop
does not fan out.

- [ ] `task` accepts several investigations and runs them together
- [ ] Test: two delegated searches overlap in time rather than queueing

### Undo a turn

Every comparable CLI has this: opencode `/undo` and `/redo`, Claude Code `/rewind` with
checkpoints. There is `/resume` here, which restores a session, and nothing that walks one back.

- [ ] Snapshot files before each prompt, capped at the 100 most recent
- [ ] `/undo` restores files, conversation, or both; `/redo` reverses it
- [ ] Say plainly what is not covered: a `bash` command's effects cannot be snapshotted
- [ ] Test: an edit is reverted, and the model's own record of it goes with it

---

## Maintenance

- [ ] Pricing table needs a source note and a date; rates drift and ours are hand-entered
- [ ] `estimateTokens` divides JSON length by four. Good enough for a compaction threshold,
      wrong enough to mislead in `/cost`. Either label it an estimate everywhere or use a
      real tokenizer
- [ ] `listPaths` walks up to 5000 files once per session. Fine for a repo, wasteful in a
      monorepo, and it never notices a file created after the first `@`
- [ ] `MUTATING_TOOLS` is now only used by tests and docs; the permission defaults are what
      actually gate a write. Either delete it or make the defaults derive from it

---

## Known rough edges

Not bugs exactly, but things that will bite someone.

- **`/clear` wipes the terminal scrollback.** `<Static>` output is already committed, so
  clearing React state alone leaves it on screen. The escape sequence works but takes the
  user's earlier terminal history with it.
- **Memory has no conflict resolution.** Two contradictory notes both persist and both get
  injected. `/memory` may merge them, or may keep both.
- **Windows `cmd /c` differs from `bash -lc`.** A command the model writes for one shell may
  fail on the other. The prompt states the platform; it does not translate.
- **An unknown name in `toolSets` is dropped silently.** The header line shows which sets
  actually loaded, but a typo reads as "that set is off" rather than as a mistake.
- **Permission rules gate the call, not what it does.** `bash` with `git *` allowed will run a
  `git` alias that shells out to anything, and there is no sandbox around the shell. Codex solves
  this with OS-level isolation — Seatbelt, Landlock, a Windows equivalent — which is three
  platform-specific implementations and not something to half-ship.
- **The reasoning panel is per-turn, not per-step.** Reasoning from an early step stays on
  screen through later ones until the turn ends.
- **An interrupted command's effects are unknown, and the model is told so.** Nothing can know
  how far a half-run migration got.
- **`@` completion lists files, not directories.** `@src/` narrows correctly, but you cannot
  complete to `src/` itself, because the walker only yields files.
- **An installed skill is a stranger's words in your system prompt.** The install shows the
  body first and `/skills` records the origin, but nothing re-checks it later: a registry that
  changes a URL's contents affects the next install, not one already on disk.
- **A registry index is trusted for its contents, not its authorship.** There are no
  signatures. `registryUrl` is the whole trust decision.

---

## Done

Kept for one release, then deleted.

- [x] Reasoning streamed to a collapsed panel, `ctrl-r` to expand, dropped when the turn ends
- [x] The tool in flight named on screen from `tool-input-start` until its result arrives
- [x] Prompts typed during a turn queue and drain in order; `esc` clears the queue
- [x] `toolSets` gating, so a disabled set reaches neither the wire nor the prompt
- [x] `multi_edit`, atomic across several edits to one file
- [x] `list_dir`, ignore-aware and depth-limited
- [x] Read-only git tools: `git_status` `git_diff` `git_log` `git_show` `git_blame`
- [x] Orphaned tool results dropped during pruning, fixing the 400 "No tool call found for
      function call output with call_id ..."
- [x] `read_many_files`, concurrent, one labelled block per file, a bad path reported in place
- [x] `@file` completion: picker fed by the ignore-aware walker, tab inserts a relative path
- [x] `ctrl-c` kills the running command and keeps the turn. The kill takes the whole process
      tree: killing `cmd /c` alone left the real command holding both pipes open, so the
      interrupt appeared to do nothing for 19 seconds
- [x] **Compaction no longer stops the loop.** Pruning used to drop any assistant part whose
      reasoning item it removed, which on a reasoning model is every tool call. The model lost
      its record of what it had run and re-ran it until the step limit. The repair strips the
      provider `itemId` instead of the part, so the same content is sent inline
- [x] **A dead provider item no longer ends the turn.** An `item_reference` resolves only while
      the provider still stores that item, so a resumed session could fail on every attempt with
      404 "Item with id 'msg_...' not found". Compaction now sends the history inline, and a 404
      naming a missing item rewrites the history inline and retries once
- [x] `/registry`: browse, search, install, and remove external skills and plugins. Skills are
      shown in full before install; plugins are a validated manifest of deny rules, never code
- [x] Context shown as a percentage of the compaction threshold, amber at two thirds, red at 90
- [x] **Permission rules per command and path**, replacing the per-tool list. `bash` was one
      yes/no for `git status` and `rm -rf`, so pressing `a` once removed the gate for both.
      Rules match the call's subject, `always` grants a pattern rather than the tool, `.env` and
      `.pem` are refused on read, and an identical call repeated three times in a turn asks even
      when allowed
- [x] **`web_fetch`**, size-capped HTTP(S) to markdown in the opt-in `net` tool set, with
      redirect and private-address checks
