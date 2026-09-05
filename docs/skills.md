# Skills

A skill is a markdown file with instructions for one kind of task. Only its name and
description sit in the system prompt; the body is loaded on demand.

That split matters. The nine bundled skills are roughly 14,000 characters of body against about
1,500 characters of catalogue — paid on every request. Putting every body in the prompt
would cost that on every turn, for instructions relevant to one turn in twenty.

## Format

```markdown
---
name: deploy
description: Ship a release. Use when asked to deploy, cut a release, or publish a build.
---

# Deploy

1. Confirm the tests pass. Do not deploy on a red suite.
2. Tag with the version from `src/version.ts`, not by hand.
3. Push the tag. CI builds and publishes.

Never deploy from a dirty working tree.
```

`name` and `description` are both required; a file missing either is skipped. The
description is what the model matches against, so write it as a trigger — "use when asked
to X" — not as a summary.

The frontmatter reader handles those two fields and nothing else. A real YAML parser would be a
dependency for two strings, so lists, nesting, and multi-line values are not supported: keep both
on one line. Quotes around a value are stripped. A body over 20,000 characters is truncated.

A file that fails to parse is skipped silently rather than reported, which is worth knowing when
a skill you wrote does not appear in `/skills` — the usual cause is a missing `---` fence or a
description spilling onto a second line.

## Where they load from

Four sources, later overriding earlier by name:

1. **builtin** — compiled into the binary
2. **registry** — `~/.shiro-neko/registry/skills/*.md`, installed with `/registry add`
3. **user** — `~/.shiro-neko/skills/*.md`
4. **project** — `.shiro/skills/*.md`

A project skill named `debug` replaces the bundled one entirely. `/skills` shows what
loaded and where each came from — which matters most for `registry`, since that body came
from someone else and is now in your system prompt. See [registry](registry.md).

`--no-skills` skips all of them, builtin included.

## The bundled skills

**`debug`** — reproduce first, form three hypotheses, disprove them cheapest-first, fix the
cause not the symptom, write a test that failed before. After two failed attempts: re-read
the error literally and check whether the code you think is running is the code that is
running.

**`review`** — severity order: incorrect behaviour, missing validation at trust boundaries,
security, resource handling, then clarity. Say plainly when something is fine. Do not invent
findings to look thorough.

**`refactor`** — establish a safety net first, move in small steps with tests green between
each, do not fix bugs while refactoring, do not add abstraction for a single caller.

**`test`** — read two existing test files first and match them, assert on behaviour not
implementation, never weaken an assertion to make a test pass, a flaky test is a shared-state
problem and not something to retry around.

**`verify`** — confirm a change works by running the artifact the way a user would, not by
reading the source. What counts as evidence, what to do with the failure path, and reporting
what was not verified.

**`commit`** — stage and commit work: look at the diff before staging, one commit one reason,
match the repository's message style, and the refusals — no amending pushed commits, no
`--no-verify`, no push unless asked.

**`security`** — find the trust boundary, then work outward: injection, missing authorisation,
path traversal, secrets in the wrong place, SSRF, hand-rolled crypto. Do not report a finding
without a path from an attacker-controlled value to the sink.

**`perf`** — measure before changing anything, find where the time actually goes, change one
thing at a time, and stop at a target stated up front. Report the baseline alongside the win.

**`migrate`** — read the changelog first, find every call site before changing one (including
CI, Dockerfiles, and docs), apply one shape of change rather than improving as you pass, and
never hand-merge a lockfile.

They are string constants in `src/skills-builtin.ts` rather than files, because
`bun build --compile` only embeds modules reachable through imports. A directory of `.md`
files would be missing from the shipped binary.

## How the agent uses one

The catalogue appears in the system prompt:

```
Skills available through the skill tool. Load one when its description matches the task,
before you start working, and follow it as if the user had written it:
- debug: Track down a bug whose cause is not obvious. Use when a test fails for unclear...
- refactor: Restructure code without changing behaviour. Use when asked to refactor...
```

When the model calls `skill({ name: "debug" })` it gets the full body back and is told to
follow it for this task. The call needs no approval — it reads nothing outside the binary.

"Before you start working" is the load-bearing phrase. A skill loaded after the work is done is
wasted tokens, and the failure mode in practice is a model that reads the catalogue, decides it
already knows, and never calls the tool. A description written as a trigger is what prevents that.

Loading one costs its body, once, in that turn's context. A 3,000-character skill is cheaper than
one wrong approach it prevents, and more expensive than the catalogue line that would have been
enough.

## Verifying a skill loaded

```bash
shiro -p "fix the failing pagination test" --json --yolo | grep skill
```

`--json` shows the `tool-call` for `skill` with the name it chose, or its absence. If the model
never calls it on a task the skill was written for, the description is the thing to change — not
the body.

## Writing a good one

Skills work when they encode what a newcomer to *your* project would get wrong. The bundled
ones are generic on purpose; yours should not be.

Useful:

```markdown
---
name: migration
description: Write or run a database migration. Use when the schema changes.
---

Migrations live in `db/migrations/` and are timestamped, never renumbered.

Run `bun run db:migrate` locally first. Staging runs them automatically on deploy;
production needs `bun run db:migrate --env=prod` by hand, after the deploy is green.

Never edit a migration that has run anywhere. Write a new one.
```

Not useful:

```markdown
---
name: quality
description: Write good code.
---

Follow best practices. Write clean, maintainable code with good naming.
```

The second costs tokens and changes nothing.

## Skill or AGENTS.md?

`AGENTS.md` is always in the prompt. A skill is loaded when its description matches.

Put standing facts in `AGENTS.md`: build commands, layout, conventions that apply to every
change. Put task-specific procedure in a skill: how to deploy, how to add a migration, how
this project debugs its worker queue.

If it applies to every turn, it belongs in `AGENTS.md`. If it applies to one kind of turn,
make it a skill.
