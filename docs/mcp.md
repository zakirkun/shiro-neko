# MCP

Model Context Protocol servers contribute tools to the agent. Two transports: a local
command over stdio, and a remote http or sse endpoint.

## Adding one from the prompt

```
/mcp              list what is configured, with the tool count each contributed
/mcp add          wizard: local or remote, then the fields that kind needs
/mcp remove <name>
```

`/mcp add` asks for the kind first, because the two need different fields — a command and
its arguments against a URL and its headers — and a single form with half of it inapplicable
is worse than two short ones.

```
Add an MCP server
none configured yet
> local    a command on this machine, over stdio
  remote   an http or sse endpoint
```

The name is validated as it is typed. Tools register as `mcp__<server>__<tool>`, so a name
with a space or a double underscore produces a tool the model cannot address and two servers
whose namespaces can collide — both are refused in place rather than at connect time. A name
already in the config is refused too.

For a local server the wizard then asks for the command and its arguments; arguments split on
spaces and keep quoted runs together, so `--root "/home/my folder"` arrives as one argument.
For a remote one it asks for the URL — http or https only — and optional headers as
`KEY: value, OTHER: value`.

Both write straight to `config.json` and merge with whatever is already there. **A new server
connects on the next start**, not mid-session: connecting during a turn would change the tool
list under a request that is already running.

`/mcp` shows the state of each configured server, which is what makes a typo visible:

```
mcp servers
/mcp add to add one

- `filesystem` (local) - 11 tools
  npx -y @modelcontextprotocol/server-filesystem .
- `api` (remote) - failed: fetch failed
  https://example.com/mcp

configured in /home/you/.shiro-neko/config.json
```

## The config file

The wizard writes this; it is equally editable by hand.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "api": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

| Field | Kind | Meaning |
|---|---|---|
| `command` | local | the executable to spawn |
| `args` | local | its arguments |
| `env` | local | extra environment variables |
| `cwd` | local | working directory |
| `url` | remote | the MCP endpoint |
| `type` | remote | `http` (default) or `sse` |
| `headers` | remote | sent with every request, for auth |

`--no-mcp` skips every server for one run, which is the first thing to try when the agent is
behaving oddly and a server is in play.

[Model Context Protocol](https://modelcontextprotocol.io) servers contribute tools. Configure
them in `~/.shiro-neko/config.json` and they appear alongside the builtins.

## Configuration

Everything the wizard writes is equally editable by hand, and a hand-written entry that
`/mcp add` would have rejected still connects — the validation is on the input path, not a
schema check at load.

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "db": {
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": { "DATABASE_URL": "postgres://localhost/dev" },
      "cwd": "/home/you/tools"
    },
    "api": {
      "url": "http://localhost:3000/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer local-dev-token" }
    }
  }
}
```

**stdio** servers take `command`, and optionally `args`, `env`, `cwd`. The process is spawned
at startup and closed on exit. `env` is merged over the inherited environment, so a server
inherits your `PATH` unless you replace it.

**Remote** servers take `url`, and optionally `type` (`http` or `sse`, default `http`) and
`headers`.

A token in `headers` sits in `config.json` in plain text, same as `apiKey`. For anything beyond
a local dev token, prefer a stdio server that reads its own credential from the environment.

## Startup cost

Servers connect **in parallel**, so the slowest one sets how long startup takes rather than the
sum of them. `npx -y some-server` re-resolves the package on each launch; installing it and
calling the binary directly is usually the difference between a noticeable wait and none.

`--no-mcp` skips them all, which is also the quickest way to tell whether a slow start is MCP
or something else.

## Naming

Tools arrive as `mcp__<server>__<tool>`. A server named `fs` exposing `read_file` becomes
`mcp__fs__read_file`.

The namespace is not cosmetic. Two servers both exposing `search` would otherwise silently
shadow each other, and the model would call one believing it was the other.

## Approval

**Every MCP tool requires approval on every call.** They are third-party code with unknown
side effects, so they are treated like `bash` rather than like `read_file`. `a` whitelists
one tool for the session.

`--yolo` skips these prompts, as it does for the builtins. Plugin guards still apply.

## Failure handling

A server that fails to start is reported and the session continues:

```
shiro-neko 0.1.0-beta.4  openai/gpt-5  session 0193ab2c
mcp: 4 tools
mcp db failed: spawn python ENOENT
```

Nothing else is lost — the other servers still load, the builtins still work. A missing
Python interpreter should not stop you from editing a file.

`--no-mcp` skips them all.

## Inspecting

`/tools` lists everything offered this turn, MCP tools included. The system prompt describes
them as a group:

```
- mcp__api__query, mcp__fs__read_file: from MCP servers, named mcp__<server>__<tool>.
  Each needs approval; read its own description before calling.
```

Their individual descriptions come from the server, so that is what the model reads before
calling one.

## Cost

Each tool adds its name, description, and JSON schema to every request. The built-ins average
548 bytes; MCP tools vary with how verbose the server's schema is. A server exposing twenty
tools costs roughly 2,750 tokens per turn, sent whether or not the model uses any of them.

MCP tools are **not** covered by `toolSets` — that budget only governs the built-ins. There is
no per-server switch either, so the choice is a server or no server, and `--no-mcp` for all of
them. If one exposes many tools you never use, a narrower server is worth finding or writing.

`/tools` shows the count both ways:

```
tools
26 offered this turn of 26 registered
```

A gap between the two numbers means a tool set or a read-only agent variant is withholding
something. MCP tools never appear in that gap.

## Writing a server

Any MCP-compliant server works. A minimal stdio one needs three methods: `initialize`,
`tools/list`, and `tools/call`. The test suite includes one at
`test/fixtures/mcp-stub.ts` — about 50 lines, and useful as a starting point.

The suite runs it as a **real subprocess** rather than mocking the transport, because the parts
that break in practice are the handshake and the framing, and a mock asserts neither.

## Debugging a server

A server that starts but returns nothing useful is the harder case. In order of speed:

1. `/tools` — did the tools arrive at all? A server with no tools is a `tools/list` problem.
2. `shiro -p "call mcp__x__y with ..." --json --yolo` — the exact `tool-call` input and
   `tool-result` output, one JSON object per line.
3. Run the server by hand: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | your-server`.
   If that is wrong, nothing above it can be right.

For an HTTP server, `curl -X POST $URL -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
answers the same question without shiro in the way.
