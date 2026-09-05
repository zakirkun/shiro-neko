# Architecture

## The loop

One turn is a `streamText` call whose stream is translated into UI events.

```
user prompt
  → messages.push({ role: 'user', ... })
  → streamText({ model, system, messages, tools, activeTools, reasoning, toolApproval })
      → for each stream part → yield an AgentEvent
      → if any tool needs approval, the stream ends suspended
          → collect decisions from the UI
          → push a tool message with the approval responses
          → loop
      → otherwise done
```

`src/session.ts` is an async generator. The UI consumes events; it never touches the SDK.
That is what lets the same session drive the Ink app, the headless printer, and the tests.

## Why approval goes through the SDK

An obvious design is a promise inside each tool's `execute`, resolved when the user answers.
That was rejected: it makes "denied" a convention the tool must remember to honour, and one
tool forgetting it is a silent security hole.

Instead the SDK's `toolApproval` is used. A denied call **provably never executes** — the SDK
never reaches `execute`. The tool cannot opt out because the tool is not consulted.

```ts
toolApproval: async ({ toolCall }) => {
  const blocked = await plugins?.guard({ toolName: toolCall.toolName, input: toolCall.input, cwd });
  if (blocked) return { type: 'denied', reason: blocked };   // --yolo cannot reach this
  if (yolo) return undefined;
  if (!needsApproval(toolCall.toolName)) return undefined;
  return 'user-approval';
}
```

Guards are checked first, so `--yolo` skips prompts but not refusals.

One subtlety: when this function denies, the SDK emits `tool-approval-request` with
`isAutomatic: true` and answers it itself. Queueing that would prompt the user for a call
that is already settled, so automatic requests are skipped and denial is surfaced from
`tool-approval-response` instead.

## Where state lives

The system prompt is rebuilt on **every step**, not once per turn:

```ts
prepareStep: ({ messages }) => {
  const instructions = this.systemFor();          // task list, memory, skills, agent
  if (estimateTokens(messages) <= threshold) return { instructions };
  return { instructions, messages: prunePreservingItems({ messages, reasoning: 'all', ... }) };
}
```

That is not an optimisation. A `todo_write` on step one must be visible to step two, and
`system:` on `streamText` is bound once for the whole run. Returning `instructions` from
`prepareStep` is the only place per-step state can enter.

The prompt also describes only the tools actually offered this turn. A prompt that mentions a
withheld tool teaches the model to attempt impossible calls. Two things narrow that set: a
read-only agent variant, and `toolSets` in config. Both go through `activeTools()`, so a
withheld tool is absent from the wire and from the prompt together.

## Rendering

Ink re-renders the whole tree on every `setState`. At 50 tokens a second that is 50 full
renders and a visibly flickering terminal.

Two things fix it:

- Finished lines go into `<Static>`, rendered once and never redrawn.
- Token deltas accumulate in a ref and flush on a 60 ms interval, not per token.

Answer text and reasoning text are separate refs on the same interval. Reasoning is shown
collapsed as a token estimate, expandable with `ctrl-r`, and dropped when the turn ends: it is
progress, not the answer, and keeping it would bury the reply it was leading up to.

Markdown is parsed on every flush. An unclosed fence renders as a code block that grows,
which is what a reader expects while text is still arriving.

## Input

`ink-text-input` was replaced. It discards up and down before its own handler, so history
recall is impossible, and it only ever *shrinks* its internal cursor offset, so an externally
set value leaves the cursor stranded mid-string.

`src/ui/PromptInput.tsx` owns the cursor and reports it with every change, which is what makes
`@path` completion possible at all. That also gives home, end, and ctrl-a/e/k/u/w for free. It
hands up, down, tab, and escape to a parent callback first, so the file picker, the command
menu, and open panels can claim them before the input treats them as editing keys.

The file picker claims those keys ahead of the command menu. While an `@` token is open, up and
down mean "move in the list", not "recall an earlier prompt".

`src/complete.ts` holds the token extraction, ranking, and insertion as pure functions, so the
rules are testable without a terminal. Two of them are decisions rather than mechanics:

- The `@` must start a word, or `user@host` opens a file picker.
- Prefix matches rank above substring matches, because `@src/` means "under `src/`" and a
  substring hit on `vendor/src/` would bury what the user pointed at.

## The prompt queue

The input stays mounted while the model works. A prompt submitted mid-turn is pushed onto a
queue and drained in order when the turn ends, going back through `submit` so a queued slash
command behaves exactly as if it were typed at that moment.

The queue is a ref as well as state. The drain runs synchronously as the turn ends, between
renders, and a closure over a stale array would silently lose a prompt. `busy` is mirrored into
a ref for the same reason.

`esc` clears the queue as well as aborting. Interrupting and then watching two more prompts
fire anyway is not what anyone means by interrupt.

## Interrupting one command

`esc` aborts the whole turn. That is the wrong tool for a runaway command, because it throws
away the conversation to stop a `sleep`.

`ctrl-c` kills the command in flight and leaves the turn alive. `src/tools.ts` keeps the
running processes by tool call id, and `interruptBash()` kills them and returns what it killed.
The call then **throws** rather than returning:

```
The user interrupted this command. It did not finish, so its effects are unknown.
```

Throwing is the point. A returned `exit: 1` reads to the model as a command that ran and
failed on its own terms, which is a different fact from a command that was stopped partway.
The model gets a tool error, and the loop continues to the next step.

The kill has to take the whole process tree. `cmd /c` and `bash -lc` run the real command as a
child, and killing the shell alone leaves that child holding both pipes open, so the read never
returns — measured at 19 seconds for a `ping -n 20` that should have died instantly. On Windows
that means `taskkill /T /F`. The kill is also awaited before the tool returns, because a
surviving grandchild keeps the working directory locked.

Ink's own `exitOnCtrlC` is turned off in `cli.tsx` so the key reaches the app; with nothing
running, the handler exits as usual.

## Subagents

`task` runs a nested `streamText` and returns one message. The subagent kinds hold different
tool sets: `explore` and `review` the read-only tools, `worker` those plus every write tool.

The consequences follow from the tool set, not from policy:

- `explore` and `review` can never need approval, because they hold no gated tool.
- `worker` needs approval for exactly the calls a direct one would, so the parent owns the
  gate: the subagent's `toolApproval` callback routes back through the parent's permission
  rules, guard plugins, and prompt. A subagent with its own approval would be a way to launder
  a tool call past the user.
- The parent's context holds the findings, not the search transcript.

Progress is reported through a callback, wired to a bus the panel subscribes to. Without the
bus the panel would need a reference to the tool, and the tool would need one to React.

## Provider differences

Two are handled explicitly.

**Thinking levels.** `off`/`low`/`medium`/`high`/`max` become `reasoning_effort` on OpenAI and
a `thinking` token budget on Anthropic. The SDK does the mapping; `src/agents.ts` only picks
the level.

**Endpoint fallback.** Newer OpenAI models reject function tools on `/v1/chat/completions`
and require `/v1/responses`. `src/fallback.ts` presents both as one model and switches when
the first rejects the request *shape* — 400, 404, 405, 415, 422, 501 with `isRetryable` false.
Retryable failures are left to the SDK's backoff.

The switch is sticky. Once an endpoint rejects the shape it will reject every later step too,
so re-probing it each turn would waste a round trip per step.

Only `api.openai.com` gets the chain. Third-party endpoints do not implement `/v1/responses`.

## Compaction and its repair

Pruning breaks two provider invariants, and `src/prune.ts` repairs both.

**A message detached from its reasoning item.** `pruneMessages({ reasoning: 'all' })` strips a
reasoning item and keeps the message item from the same response. A part carrying a provider
`itemId` is not sent inline: the responses provider serialises it as
`{ type: 'item_reference', id }`, pointing at an item stored on their side, and that stored
item depends on the reasoning item that pruning just removed. The result is a 400.

The two carry different ids, so they cannot be matched by id. What links them is the assistant
message they arrived in: one message is one response, and its reasoning item covers every
other item in it. `detachOrphanedItems` strips the `itemId` from those parts, which is what
sends the same content inline instead — verified against the provider's own serialiser, where
a `text` part with an itemId goes out as `item_reference` and the identical part without one
goes out as `output_text`.

Dropping the parts was the first attempt and it broke the loop. On a reasoning model every
tool call carries an itemId, so after the first compaction the model could not see what it had
already run, and re-ran the same tools until the step limit ended the turn. **Compaction may
shorten the history; it must not blank it.**

**A tool result without its tool call.** Tool pruning counts messages, so a cut can land between
an assistant `tool-call` and the `tool` message answering it. What reaches the wire is a
`function_call_output` with no `function_call`:

```
400 No tool call found for function call output with call_id call_…
```

`dropOrphanedResults` collects the surviving call ids and drops any result that has none. The
reverse pairing is deliberately left alone: a call still awaiting its result is exactly what a
suspended approval looks like, and dropping it would break resume.

**An item the provider no longer holds.** A reference resolves only while the item is still in
provider storage, which a resumed session or an endpoint fallback cannot count on:

```
404 Item with id 'msg_…' not found.
```

Nothing about the same history can succeed on retry, so `pruneToFit` strips every provider
`itemId` from what it sends, and `Session.run` answers that 404 by rewriting its own history
inline and running the request again — once per turn, and only when the rejection arrived before
any output, since delivered text cannot be unsent.

The pruning ladder drops reasoning first and then keeps the widest recent tool tail that fits.
The SDK carries that returned message view into later steps, and the session reports compaction
once per turn rather than once per step.

## Registry

`/registry` fetches an index of external skills and plugins over https. Skills are prompt text
and are shown in full before install; plugins are a JSON manifest of refusal rules, never code.
The guard evaluating those rules is compiled, identical for every installed plugin, so an entry
from a registry cannot execute anything. See [registry](registry.md) for the validation and
the reasoning.

`src/registry.ts` has no UI and no side effects until `install()` is called, which is what lets
`stage()` show a body before it becomes part of every future prompt.

## Module map

| Module | Responsibility |
|---|---|
| `session.ts` | the loop, approvals, compaction, event stream |
| `tools.ts` | file and shell tools, tool sets, ripgrep bridge, bash streaming and interrupt |
| `tools-git.ts` | read-only git tools, spawned with a fixed argv |
| `commit.ts` | `git_commit_message`, a nested model call over the staged diff |
| `tools-net.ts` | `web_fetch`, private-address and redirect checks |
| `ignore.ts` | gitignore-aware walker, path jail |
| `complete.ts` | `@path` token extraction, ranking, insertion |
| `registry.ts` | external index, validation, install and removal |
| `prompt.ts` | system prompt assembly from live state |
| `agents.ts` | variants, thinking levels |
| `skills.ts` | discovery, catalogue, `skill` tool |
| `memory.ts` | durable notes, search, model compaction |
| `notebook.ts` | session task list |
| `plugins.ts` | host, hooks, guard chain |
| `subagent.ts` | `task` tool and progress events |
| `ask.ts` | the `ask` tool |
| `mcp.ts` | MCP clients and namespacing |
| `fallback.ts` | endpoint chain |
| `prune.ts` | provider-item and tool-pairing repair |
| `markdown.ts` | parser, no dependency |
| `store.ts` | sessions, prompt history |
| `farewell.ts` | the exit message and its resume commands |
| `config.ts` | resolution, model construction |
| `providers.ts` | presets, `/models` fetch |
| `pricing.ts` | USD rates |
| `commands.ts` | slash registry, parsing, menu matching |
| `headless.ts` | `-p` mode |
| `cli.tsx` | argv, wiring, lifecycle |
| `ui/App.tsx` | state, the turn loop, slash-command routing |
| `ui/transcript.ts` | line types, tool argument and result formatting |
| `ui/buses.ts` | notice and subagent channels, subagent view folding |
| `ui/Approval.tsx` | the approval bridge and its prompt |
| `ui/Pickers.tsx` | command menu, shared list picker, install confirm |
| `ui/panel-bodies.ts` | `/tools`, `/cost`, `/context`, `/todos` bodies |
| `ui/Panels.tsx` | presentational panels and the status bar |
| `ui/*` | remaining Ink components |

Every module is pure of the UI except `ui/`, and `ui/` never touches the SDK. The seam is the
`AgentEvent` stream.

## Testing

538 tests became 713 as the suites grew; no mocking framework. `MockLanguageModelV4` from
`ai/test` drives the loop; `ink-testing-library` drives the UI with real keystrokes; MCP is
tested against a real stdio server subprocess; provider wire formats and the registry are
tested against a local HTTP server; the interrupt path spawns a real subprocess and asserts it
died early rather than ran out.

The pattern throughout is to assert on what actually crossed a boundary — what went on the
wire, what is on screen, what is on disk — rather than on internal calls.

Compaction is asserted on **behaviour**, not shape: the loop must terminate because the model
chose to, and every call after the first must still carry the earlier exchange. A shape
assertion would have passed while the model was losing its memory.
