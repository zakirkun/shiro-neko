# Memory and state

Four kinds of state, each with a different lifetime.

| State | Lives in | Survives |
|---|---|---|
| transcript | the message array | until `/compact` or `/clear` |
| task list | the system prompt, rebuilt each step | pruning and `/compact` |
| project memory | `~/.shiro-neko/memory/<hash>.json` | across sessions, forever |
| session record | `~/.shiro-neko/sessions/<uuid>.json` | until you delete it |

The split exists because compaction is destructive. `pruneMessages` deletes tool results and
`/compact` deletes the whole transcript, so anything recorded only in messages is lost
exactly when a long task needs it most.

The practical rule: if it should survive this turn, `todo_write` it. If it should survive this
session, `remember` it. The transcript is for the conversation, not for storage.

## Project memory

Durable notes about the codebase, injected at the start of every session.

### `remember`

```
kind  fact | decision | gotcha | command
text  one self-contained line
```

- **fact** — how something is. "The API is versioned under `/v2`."
- **decision** — what was chosen and why. "We use snake_case for DB columns; the ORM
  expects it."
- **gotcha** — a trap. "The migration must run before the seed or the FK fails."
- **command** — an invocation that works. "Tests run with `bun test`, not `npm test`."

Duplicates are refused. Text is capped at 400 characters, the store at 300 entries.

The kinds are not decoration: they are what the model reads back at boot, and they set how much
to trust a note. A `command` is verifiable in one run. A `decision` explains why the obvious
alternative was not taken, which is the thing a newcomer most often gets wrong.

"One self-contained line" is the part that matters most. A note reading "use the new approach"
is worthless next session — there is no conversation left to say which approach.

### `recall`

Every term must appear. A match increments that entry's hit count, which protects it from
compaction later — an entry the agent actually uses is worth keeping verbatim.

AND rather than OR, on purpose: "migration seed order" should find the one note about that,
not every note mentioning any of the three words. Returns the 15 most recent matches.

### `forget`

Removes by substring, for a note that turned out wrong.

### What the agent sees

```
What you learned about this project in earlier sessions. Trust it, but verify anything
that contradicts what you can see in the code now:
- (command) tests run with bun test, not npm test
- (gotcha) the migration must run before the seed
- (decision) snake_case for DB columns, the ORM expects it
```

Top 20 by hit count, then recency. The "verify anything that contradicts" line matters:
memory goes stale and a confidently wrong note is worse than none.

### Compacting

`/memory` has the model merge entries. Two rules make it safe:

- Entries with at least one recall are kept verbatim and never merged.
- A model returning nothing parseable leaves the store untouched.

Without the second rule a bad response wipes everything the agent has learned. The store also
has to be past 60 entries with at least two unused ones before anything happens, so `/memory`
on a small store is a deliberate no-op rather than a rewrite.

`/notes` lists the store with hit counts. `--no-memory` disables loading and writing.

## Task list

`todo_write` replaces the whole list each call. Four states:

```
tasks ##########.............. 1/4  1 blocked
[x] read the pagination code
[~] fix the boundary
[ ] add a test
[!] update the docs  (no write access to the wiki)
```

`blocked` requires a note saying what is blocking it. The tool warns when more than one task
is `in_progress`, when nothing is `in_progress` while work remains, or when a `blocked` task
has no note.

The list is re-rendered into the system prompt on **every step**, not once per turn — a
`todo_write` on step one has to be visible to step two. It is saved with the session and
restored by `-c` or `/resume`.

`/todos` shows it. The panel above the input shows it live.

## Sessions

Every turn autosaves, debounced 400 ms so a long tool loop does not hit the disk each step.

```json
{
  "id": "0193ab2c-…",
  "createdAt": "…", "updatedAt": "…",
  "cwd": "/home/you/project",
  "provider": "openai", "model": "gpt-5",
  "title": "why does the pagination test fail?",
  "inputTokens": 48210, "outputTokens": 3105,
  "costUsd": 0.0913,
  "notebook": { "todos": [ … ] },
  "messages": [ … ]
}
```

```bash
shiro -c                  # newest session for this directory
shiro -r 0193ab2c         # by id or unique prefix
```

Both are printed as shiro exits, so the id is on screen rather than in a directory you
have to go looking through:

```
Good bye.
Saved 8 messages: "why does the pagination test fail?"

Resume it with:
  shiro -c                    newest session in this directory
  shiro -r 0193ab2c           this session by id
```

A session with no messages was never written, so it says so instead of naming a command
that would find nothing.

```
/sessions   list the last 15
/resume <id>
/save       write now instead of waiting for the debounce
```

A corrupt session file is skipped rather than crashing the list.

Ids are UUIDv7, so they sort by creation time and a prefix is usually enough to identify one.
`-c` matches on `cwd`, so it picks up the newest session **for this directory** rather than the
newest overall — two projects side by side do not steal each other's `-c`.

Resuming restores the messages and the task list, but not the model or agent variant: those come
from the current config and flags. A session started with `--agent deep` resumes as `default`
unless you pass it again.

## Compaction

Two mechanisms.

**Automatic**, at roughly 120k estimated tokens: reasoning is stripped first, then older tool
content is removed in a bounded ladder until the request fits. The SDK keeps that pruned view
for later steps in the turn; local session history remains complete. One `compacted` event is
reported per turn:

```
context compacted: 192 messages pruned to 15 on the wire
```

The status bar warns before that happens: context is shown as a percentage of the threshold,
amber from two thirds, red at 90.

What gets discarded, in order: reasoning items first, then the oldest tool calls and results as
needed. Recent exchanges are kept by the ladder, which lets a turn continue rather than restart.

**Manual**, `/compact`: the model writes a summary — goal, files touched, decisions, commands
and outcomes, what remains — and it replaces the transcript entirely.

The difference is which history is destroyed. Automatic pruning touches the wire only, so
scrolling back still shows everything and `/save` records everything. `/compact` replaces the
real message array, so it is irreversible for that session.

Use `/compact` when a session has drifted across several unrelated tasks and the early part is
noise. Let automatic pruning handle a single long task, since it keeps the recent work intact.

### The pruning repair

Pruning breaks two provider invariants. `src/prune.ts` repairs both, and both were real 400s
before it did.

**A message without its reasoning item.** `pruneMessages({ reasoning: 'all' })` strips a
reasoning item and keeps the message item from the same response. That message carries a
provider `itemId`, and the OpenAI responses provider serialises anything with one as
`{ type: 'item_reference', id }` — a pointer to an item stored on their side, which depends on
the reasoning item that is now gone:

```
400 Item 'msg_…' of type 'message' was provided without its required 'reasoning' item: 'rs_…'
```

The two carry different ids, so they cannot be matched by id. What links them is the
assistant message they arrived in — one message is one response. `detachOrphanedItems` strips
the `itemId` from those parts. Without one the same content is serialised **inline**, which
carries no dependency on anything stored, so the turn survives intact.

Dropping the parts instead was the first attempt, and it was wrong in a way that only showed
up over a long turn: on a reasoning model every tool call carries an itemId, so after the
first compaction the model could no longer see what it had already run. It re-ran the same
tools until the step limit ended the turn. The history is the model's memory; compaction may
shorten it but must not blank it.

**A tool result without its tool call.** Tool pruning counts messages, not call/result pairs, so
the cut can land between the assistant message holding a `tool-call` and the `tool` message
answering it:

```
400 No tool call found for function call output with call_id call_…
```

`dropOrphanedResults` drops any result whose call id no longer survives. The reverse is left
alone deliberately: a tool call still waiting for its result is what a suspended approval looks
like, and dropping it would break `/resume`.

**An item the provider no longer holds.** An `item_reference` only resolves while the item is
still in provider storage. A session resumed the next day, or one that fell back from
`/v1/chat/completions` to `/v1/responses` mid-turn, can carry references to items that are gone:

```
404 Item with id 'msg_…' not found.
```

Retrying that history fails identically every time, so there is nothing to wait for. Two things
answer it. Compaction now strips every provider `itemId` from the history it sends, so a pruned
turn is always inline; and a 404 naming a missing item rewrites the session's own history inline
and runs the request again — once per turn, reported as:

```
the provider no longer had part of this session stored. Re-sent the history inline and carried on.
```

Only a rejection *before* any output is repaired. Once text is on screen it cannot be unsent, and
a retry would say it all a second time.

### What compaction still does not do

It tells the model the history was pruned but not what was in it. A decision from forty messages
ago can be contradicted with confidence, because from the model's side that span never existed.
Summarising the discarded part is [next on the list](../TODO.md).

The threshold is also measured with `JSON.stringify(messages).length / 4`, which is an estimate.
It is fine for deciding when to prune and wrong enough that it should not be read as a token
count — the real numbers in `/cost` come from the provider.

## Prompt history

Per-directory, capped at 200, deduplicated against the previous entry. Up and down in the
input walk it; down past the newest restores what you were typing. While an `@` token is open
those keys move in the file picker instead.

Stored at `~/.shiro-neko/history/<hash>.json`, where the hash is a SHA-256 prefix of the
project path.

## The prompt queue

Not persisted, and deliberately so. A prompt typed during a turn lives in memory until the turn
ends, then runs. `esc` clears it along with aborting the turn, and quitting discards it — a
queued thought that fires on next launch, against a workspace that has since changed, is worse
than a lost one.
