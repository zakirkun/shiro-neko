# Development

## Setup

```bash
git clone https://github.com/zakirkun/shiro-neko
cd shiro-neko
bun install
```

Bun 1.3.14 or newer. Nothing else is required, though `rg` on PATH makes `grep` about 15x
faster and the fallback path is exercised without it.

## Commands

```bash
bun run shiro          # run from source
bun run typecheck      # tsc --noEmit
bun test               # 713 tests
bun run build          # single binary for this platform -> dist/shiro
bun run release        # all five platforms -> dist/release + SHA256SUMS
bun run install:local  # build, then copy onto PATH
```

`bun run install:local` copies the compiled binary. Do not use `bun link`: it writes a shim
that re-execs `bun`, which fails on any machine where bun was installed without `bun.exe` on
PATH — an npm install of bun, for instance. The compiled binary embeds its own runtime.

`SHIRO_INSTALL_DIR` overrides the target directory.

## Testing

No mocking framework. Everything is driven through a real boundary.

```ts
// The loop: a mock provider, asserting what crossed the wire.
const seen: LanguageModelV4CallOptions[] = [];
const model = new MockLanguageModelV4({
  doStream: async (o) => { seen.push(o); return stream(text('ok')); },
});
const session = new Session({ model, askApproval: async () => 'deny', agent: variantByName('plan') });
for await (const _ of session.send('investigate')) void _;

const offered = (seen[0]?.tools ?? []).map((t) => t.name);
expect(offered).not.toContain('write_file');
```

```ts
// The UI: real keystrokes, asserting what is on screen.
const app = render(<App session={session} bridge={bridge} hooks={testHooks()} header="hdr" />);
app.stdin.write('/');
await wait(120);
expect(app.lastFrame()).toContain('/compact');
```

Provider wire formats are tested against a local `Bun.serve`. MCP is tested against a real
stdio subprocess. Tools are tested in a temp directory with `process.chdir`.

`SHIRO_HOME` points config, sessions, memory, and history at a temp directory, so a test run
never touches your real state.

### What to assert

Assert on what crossed a boundary: the request body, the rendered frame, the file on disk.
Not on internal calls.

That is not style. Several real bugs were caught this way and would have passed a
mock-verification test:

- `pruneMessages` leaving a message item without its reasoning item — visible only in the
  request body
- `pruneMessages` leaving a tool result without its tool call — same, and it took a stub
  endpoint that rejected the pairing to prove the fix
- A provider item the server had dropped — visible only as a 404 from a stub endpoint that
  refused any `item_reference`, and only fixable by comparing the two request bodies the
  session sent
- Compaction blanking the model's memory of its own tool calls — invisible in any single
  request, and visible only as "the loop ran to its step limit". Caught by asserting the loop
  terminated because the model chose to, not that the messages had a particular shape
- `--json` serialising `Error` as `{}` — visible only in the printed output
- Automatic approval requests prompting the user — visible only in the event sequence
- `ctrl-c` killing `cmd /c` but not the command under it — visible only as elapsed time, since
  the interrupt reported success while the command ran for another 19 seconds

## Adding a tool

1. Define it in `src/tools.ts` with a `zod` schema. Descriptions are read by the model, so
   write them as guidance, not as documentation.
2. Add it to the `tools` object.
3. Add it to a set in `TOOL_SETS`. A tool in no set can never be gated off.
4. If it mutates anything, add it to `MUTATING_TOOLS` so it requires approval.
5. Add a line to `TOOL_DOCS` in `src/prompt.ts` saying *when* to reach for it.
6. If it is read-only, add it to `READ_ONLY` in `src/agents.ts` so `plan` and `review` can use
   it.
7. Test the behaviour in a temp directory, including the failure path.

Steps 3 and 4 are two hand-maintained lists of tool names, which is a known weakness: a tool
added to one and forgotten in the other is a silently ungated write. Deriving both from the
tool definitions is on [TODO.md](../TODO.md).

Every tool costs roughly 550 characters of schema on every request. Nineteen built-in tools is
past where selection accuracy starts to matter, which is why sets exist and why a new tool
needs to earn its place — see [ROADMAP.md](../ROADMAP.md) for what has been declined and why.
One set, `net`, is opt-in rather than on: `web_fetch` is the one tool that leaves the machine.

## Adding a slash command

`src/commands.ts` is the single source of truth. Add a `CommandSpec` to `COMMANDS`, a case to
`parseCommand`, and a case in `App.tsx`. The menu, `/help`, and the parser all read from that
one array, and a test asserts every entry parses and appears in help — they cannot drift.

## Code conventions

Sample a neighbouring file before inventing a pattern. Broadly:

- No comment that restates the code. Comments explain *why*, and usually only where something
  non-obvious was forced by an external constraint.
- No `as any`, no `@ts-ignore`. `tsconfig.json` runs strict with
  `noUncheckedIndexedAccess`.
- Validate at trust boundaries — model output, file contents, network responses. Not between
  internal functions.
- Duplication over premature abstraction. No interface with one implementation.
- Errors carry what the reader needs to act. `oldString appears 3 times in src/x.ts` beats
  `edit failed`.

## Releasing

The version lives in `src/version.ts`, compiled into the binary. `package.json` carries it too
for tooling, and `bun run release` refuses to build if the two disagree, or if a git tag
disagrees with either:

```
$ GITHUB_REF_NAME=v9.9.9 bun run release
tag v9.9.9 does not match src/version.ts (0.1.0-beta.5). Bump the version or retag.
```

A binary reporting the wrong version is worse than a failed release.

To cut one:

```bash
# bump src/version.ts and package.json to the same value
git commit -am "release 0.1.0-beta.5"
git tag v0.1.0-beta.5
git push --follow-tags
```

Cross-compilation is the part that only breaks in CI. `bun run release` on Windows
takes a different branch from the Ubuntu runner — `--windows-title` is accepted on a
Windows host and rejected everywhere else — so a green local release is not proof.
`buildArgs()` is unit-tested for both hosts because of exactly that.

`.github/workflows/release.yml` then runs typecheck and tests, cross-compiles all five
targets on one Ubuntu runner, asserts the built binary reports the expected version, and
publishes a GitHub release with the binaries and `SHA256SUMS`. A tag containing `-` is
published as a prerelease.

Bun cross-compiles from any host, which is why there is no build matrix. Verified: a working
`darwin-arm64` binary builds on Windows.

Publishing is gated on a `v*` tag, so a manual `workflow_dispatch` run produces artifacts
without releasing.

## CI

`.github/workflows/ci.yml` runs typecheck, tests, and a build on Ubuntu, macOS, and Windows
for every push and PR.

All three are necessary. The tools shell out to `rg`, `git`, and a platform shell, and path
handling differs — a Windows-only break is invisible on Linux until someone hits it.

## Debugging the agent itself

`--no-plugins --no-skills --no-memory --no-instructions --no-subagent --no-mcp` strips it to
the built-in tools alone, which isolates whether a problem is the loop or something layered on
it. `{ "toolSets": [] }` narrows it further, to the six core tools.

`--json` in headless mode shows the exact event sequence.

For provider issues, a local `Bun.serve` that logs the request body and returns a canned SSE
stream answers "what did we actually send" faster than any amount of reading. Several bugs in
this codebase were found that way. Making that stub *reject* the thing you think you fixed is
better still: the tool-pairing repair was confirmed by a stub that returned the real 400 for an
orphaned result, then stopped doing so.
