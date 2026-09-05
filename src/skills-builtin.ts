/**
 * Skills bundled with the binary.
 *
 * These are string constants rather than files on disk because `bun build --compile`
 * only embeds modules reachable through imports; a directory of .md files would be
 * missing from the shipped binary.
 */
export const BUILTIN_SKILLS: { name: string; source: string }[] = [
  {
    name: 'debug',
    source: `---
name: debug
description: Track down a bug whose cause is not obvious. Use when a test fails for unclear reasons, behaviour differs between environments, or an earlier fix did not hold.
---

# Debugging

Do not guess. A guess that happens to work leaves the real cause in place.

## Reproduce first

Find the smallest command that shows the failure and record it with \`remember\`. If you
cannot reproduce it, say so and ask what the user did differently — do not proceed on a
hypothesis you cannot test.

## Three hypotheses, then evidence

Write down at least three causes that would produce this exact symptom. Rank them by how
cheap they are to disprove, then disprove them in that order. State which one you are
testing before you test it.

Evidence means observed output: a log line, a failing assertion, a value printed at the
point of failure. "It should be X" is not evidence.

## Bisect when the space is large

- Recent regression: check what changed last.
- Unclear layer: assert the value at each boundary until one is wrong.
- Intermittent: run it in a loop and capture the failing case, do not reason about it abstractly.

## Fix the cause

Once you know the cause, fix that and nothing else. Do not tidy surrounding code in the
same change — a bugfix diff should contain only the bug.

Write a test that fails before the fix and passes after. If you cannot express the bug as
a test, say why.

## After two failed attempts

Stop. Re-read the error text literally, character by character. Check your assumption
about which code is actually running: the wrong file, a stale build, a shadowed import,
or a cached dependency accounts for most "impossible" bugs.
`,
  },
  {
    name: 'review',
    source: `---
name: review
description: Review a diff or a file for defects. Use when asked to review, critique, or check code before it ships.
---

# Code review

Severity order. Do not lead with style.

1. **Incorrect behaviour** — wrong result, wrong edge case, wrong state after failure.
2. **Missing validation at trust boundaries** — user input, network responses, file contents,
   anything crossing a process line. Internal calls need no defensive checks.
3. **Security** — injection, path traversal, secrets in logs or errors, missing authz.
4. **Resource handling** — unclosed handles, unbounded growth, unawaited promises.
5. **Clarity** — only when it will cause a future defect.

## For each finding

State file and line, what breaks, and the change. Show the fix as code when it is short.

Skip anything a formatter would fix. Skip preference. If a choice is defensible, leave it.

## Say when it is fine

A review that invents problems to look thorough is worse than a short one. If the change
is correct, say so and stop.

## Verify, do not assume

Read the surrounding code before calling something a bug. A "missing" null check often
exists one level up. Run the tests if that is what settles it.
`,
  },
  {
    name: 'refactor',
    source: `---
name: refactor
description: Restructure code without changing behaviour. Use when asked to refactor, clean up, extract, or reorganise.
---

# Refactoring

Behaviour must not change. That is the whole constraint.

## Establish the safety net first

Run the existing tests and record that they pass. If the code has no tests, write one that
pins current behaviour — including the ugly parts — before touching anything. Refactoring
untested code is rewriting it.

## Then move in small steps

One transformation at a time, tests green between each. Rename, then extract, then move —
not all three in one edit. A large refactor that fails leaves you unable to tell which step
broke it.

## What not to do

- Do not fix bugs while refactoring. Note them, finish, fix separately.
- Do not add abstraction for a single caller. Duplication beats a premature interface.
- Do not widen the scope. The request was this code, not its neighbours.
- Do not change public API unless asked; if it must change, say so first.

## Done means

Tests pass, behaviour is identical, and the diff is smaller than the reader feared.
`,
  },
  {
    name: 'test',
    source: `---
name: test
description: Write or repair tests. Use when adding coverage, fixing a flaky test, or asked how something should be tested.
---

# Testing

A test earns its place by failing when the code is wrong.

## Match the project

Read two existing test files first. Use their runner, their assertion style, their file
layout, their naming. A test that looks foreign is a test nobody maintains.

## Test behaviour, not implementation

Assert on what a caller observes. A test that reaches into private state breaks on every
refactor and catches nothing.

Cover: the normal case, the boundaries, and the failure. Failure cases catch more real
defects than happy paths.

## Never do this

- Do not assert what the code currently returns without knowing it is correct — that pins
  the bug.
- Do not weaken an assertion to make a test pass. If it fails, either the code or the
  expectation is wrong; find out which.
- Do not delete a failing test. It is telling you something.

## Flaky tests

A test that passes alone and fails in a suite is a shared-state problem: a global, a
temp directory, a port, an unawaited promise, or ordering. Find which, do not add a retry.

## Verify

Run the test and watch it fail before the fix, pass after. A test you never saw fail is
not known to work.
`,
  },
  {
    name: 'verify',
    source: `---
name: verify
description: Confirm a change actually works by using it, not by reading it. Use before reporting a task complete, or when asked whether something works.
---

# Verification

A green test suite says the tests pass. It does not say the feature works.

## Run the artifact, not the source

Build it and use it the way a user would:

- **CLI** — build the binary and run it. Happy path, bad input, \`--help\`. Read the output.
- **HTTP service** — start it and \`curl\` the endpoint. Check the status and the body.
- **Library** — write a throwaway script that imports and calls the new code end to end.
- **Script or job** — run it against real input and inspect what it produced.

Delete the throwaway afterwards.

## What counts as evidence

Command output you actually saw. Paste the relevant lines, not a summary of them.

These are not evidence:

- "The tests pass" for a change tests do not cover.
- "The types check" for anything about runtime behaviour.
- "It should work now" for anything at all.

## Check the failure path too

Feed it the input you expect to be rejected and confirm it is rejected, with a message
that says why. A feature that works only on correct input is half-built.

## Report what you did not verify

Say plainly what you could not run and why: a missing credential, a service you cannot
start, a platform you are not on. An honest gap is useful; a claim that hides one is not.

## When verification fails

The defect is yours to fix in this turn. Do not report the task complete with a note that
it did not work.
`,
  },
  {
    name: 'commit',
    source: `---
name: commit
description: Stage and commit work. Use when asked to commit, or to split existing changes into commits.
---

# Committing

Never commit unless the user asked. If it is unclear whether they did, ask.

## Look before you stage

\`git_status\` and \`git_diff\` first. You are looking for two things:

1. Changes that are not yours. Another agent or the user may share this worktree, and
   \`git add .\` takes their half-finished work with yours.
2. Files that should never be committed: \`.env\`, credentials, keys, large build output,
   anything a \`.gitignore\` rule was supposed to catch and did not. Flag these to the user
   rather than committing them.

Stage the specific paths you changed. \`git add .\` is how unrelated work ends up in a
commit that then has to be reverted whole.

## One commit, one reason

If the diff does two unrelated things, make two commits. A commit that both fixes a bug and
renames a module cannot be reverted, cherry-picked, or bisected usefully.

## The message

Match the repository's existing style — read \`git_log\` before writing one. Failing that:

- A subject line under 70 characters, imperative, saying what changed.
- A body explaining *why*, when the reason is not obvious from the diff. Wrap at 72.
- No "as requested", no restating the diff line by line, no emoji unless the repo uses them.

## Do not

- Do not \`--amend\` a commit that has been pushed. Write a new one.
- Do not \`--no-verify\`. If a hook rejects the commit, the hook found something.
- Do not \`git push\` unless asked, and never force-push without being asked explicitly.
- Do not commit and then immediately fix it up with a second commit. Get it right, or say
  what is wrong.

## After committing

Report the short hash and the subject. If a hook rewrote files, say so and confirm the
final state is what was intended.
`,
  },
  {
    name: 'security',
    source: `---
name: security
description: Review code for security defects, or write code that handles untrusted input. Use when touching authentication, user input, file paths, shell commands, SQL, or anything reachable from the network.
---

# Security

Find the trust boundary first. Everything crossing it is hostile until parsed.

## The boundaries in most codebases

- Request bodies, query strings, headers, cookies.
- File contents and filenames, including paths a user supplied.
- Environment variables in a multi-tenant deployment.
- Anything a model or a third-party API returned.

Inside a boundary, values are already validated and re-checking them is noise. At the
boundary, nothing is optional.

## What to look for, in order

1. **Injection.** String-built SQL, shell commands assembled from input, \`eval\`, template
   rendering with user data as the template rather than the data. The fix is parameters and
   argument arrays, never escaping.
2. **Missing authorisation.** An endpoint that checks *who* you are but not *what* you may
   touch. Look for an id taken from the request and used without an ownership check.
3. **Path traversal.** \`../\` in anything joined onto a filesystem root. Resolve, then verify
   the result is still inside the root — a prefix check on the raw input misses
   \`a/../../secret\`.
4. **Secrets in the wrong place.** Keys in source, in logs, in error messages, in a commit.
   A secret that reached a log is a secret to rotate.
5. **Server-side request forgery.** A URL from input, fetched. Block private and loopback
   addresses by *resolved* address, and re-check every redirect hop.
6. **Weak crypto and hand-rolled auth.** Homemade token formats, \`Math.random\` for anything
   security-bearing, comparisons on secrets that are not constant time.

## What not to do

Do not report a finding you cannot trace to a concrete input. "This could be unsafe" without
a path from an attacker-controlled value to the sink is noise that buries the real one.

Do not fix a symptom at one caller when the sink is shared. Grep every caller and fix the
seam once.

## Reporting

File, line, the path from input to sink, and the fix. Say plainly when a thing that looks
dangerous is actually fine, and why — a reviewer's confidence is worth as much as a finding.
`,
  },
  {
    name: 'perf',
    source: `---
name: perf
description: Make something faster, or find out why it is slow. Use when a command, request, test suite, or build takes longer than it should.
---

# Performance

Measure first. A change made without a number before it is a guess with extra steps.

## Get a number

Time the actual operation, not a proxy for it. \`time\`, the framework's own timing output,
or a loop around the slow call with a timestamp either side. Record the baseline with
\`remember\` so the comparison survives compaction.

If you cannot measure it, say so and stop. Optimising an unmeasured path is how a codebase
accumulates complexity that buys nothing.

## Find where the time goes

- **Wall-clock dominated by one call?** Look there and nowhere else.
- **Spread evenly?** Suspect the loop around it: an O(n²) walk, a query per row, a file read
  per iteration.
- **Idle time?** It is waiting: a sequential chain of independent awaits, an unpooled
  connection, a lock.

The usual culprits, in the order they actually appear: N+1 queries, work repeated inside a
loop that could be hoisted, a missing index, sequential awaits that could run together,
reading a whole file to use one line, and re-parsing something that could be parsed once.

## Change one thing

One change, then re-measure. Two changes together and you do not know which one paid — and
one of them may have cost.

## Stop when it is fast enough

State the target before you start: "the test suite under a minute", "the endpoint under
200ms". Past the target, further work is complexity with no user on the other end of it.

## Report

Baseline, change, new number, and what you did not do. A 40% win with one line changed is a
better report than a 45% win that restructured a module.
`,
  },
  {
    name: 'migrate',
    source: `---
name: migrate
description: Upgrade a dependency, framework, or language version across a codebase. Use when a major version bump, a deprecation, or a breaking API change has to be applied.
---

# Migration

The failure mode is a half-applied migration: it compiles, most tests pass, and one code
path still uses the old API.

## Read the changelog before the code

Find what actually broke. A major version usually has a migration guide; read it and list
the changes that apply to this codebase specifically. Below 1.0, treat a minor bump as
breaking — semver promises nothing there.

## Find every call site before changing one

Grep for the old API across the whole repository, including tests, scripts, config, CI
workflows, Dockerfiles, and documentation. A version literal pinned in a workflow while the
manifest says something else is a split-brain deploy.

Write the list down with \`todo_write\`. The list is the migration; the edits are mechanical.

## Change in one shape

Apply the same transformation everywhere rather than improving each site as you pass
through it. A migration mixed with refactoring cannot be reviewed, and cannot be reverted
if the upgrade turns out to be wrong.

\`apply_patch\` is the tool for this: one atomic patch across the files that must land
together.

## Verify at the boundary that broke

Type checks catch signature changes and miss behaviour changes. Run the tests, then actually
use the thing that was upgraded: start the server, run the CLI, execute the query. A green
suite over an untested upgrade path proves the suite did not cover it.

## Never hand-merge a lockfile

On a conflict, take either side whole and regenerate with the package manager. The resolver
owns that file.

## Report

The version before and after, every file class touched, what you verified by running, and
anything the changelog said applies that you deliberately did not do.
`,
  },
];
