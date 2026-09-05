# Configuration

Settings come from three places. Later wins:

1. `~/.shiro-neko/config.json`
2. environment variables
3. command-line flags

## The config file

Written by `/provider`, editable by hand. Every field is optional.

```json
{
  "provider": "openai",
  "model": "gpt-5",
  "baseURL": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "presetId": "openai",
  "agent": "default",
  "thinking": "medium",
  "maxRetries": 3,
  "plugins": ["guard", "time"],
  "toolSets": ["edit-plus", "git"],
  "permission": {
    "bash": { "*": "ask", "git *": "allow" }
  },
  "registryUrl": "https://example.com/my-registry/index.json",
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

| Field | Meaning |
|---|---|
| `provider` | wire protocol: `anthropic` or `openai`. Not the vendor — Groq, OpenRouter, and Ollama all speak `openai` |
| `model` | model id as the endpoint names it |
| `baseURL` | API root. Defaults to the official endpoint for the provider |
| `apiKey` | sent as `Authorization: Bearer` for `openai`, `x-api-key` for `anthropic` |
| `presetId` | which preset `/provider` chose, so it can show what is configured |
| `agent` | default variant: `default`, `quick`, `deep`, `plan`, `review` |
| `thinking` | default level: `off`, `low`, `medium`, `high`, `max` |
| `maxRetries` | retries per model call for transient failures. Default 3 |
| `plugins` | which builtin plugins to enable. Omit for `["guard", "secrets", "protect", "time"]` |
| `toolSets` | optional tool sets beyond `core`: `edit-plus`, `git`, and `net`. Omit for the defaults; `net` is opt-in. See [tools](tools.md) |
| `permission` | which calls run, ask, or are refused, matched per command or path. See [permissions](permissions.md) |
| `registryUrl` | index for `/registry`. Omit for the default. See [registry](registry.md) |
| `mcpServers` | see [MCP](mcp.md) |

## Provider presets

`/provider` offers these. Each sets `baseURL` and the wire protocol for you.

| Preset | Protocol | Endpoint | Env var checked |
|---|---|---|---|
| Anthropic | `anthropic` | `api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `api.openai.com/v1` | `OPENAI_API_KEY` |
| OpenRouter | `openai` | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Groq | `openai` | `api.groq.com/openai/v1` | `GROQ_API_KEY` |
| DeepSeek | `openai` | `api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| xAI | `openai` | `api.x.ai/v1` | `XAI_API_KEY` |
| Ollama | `openai` | `localhost:11434/v1` | none, keyless |
| LM Studio | `openai` | `localhost:1234/v1` | none, keyless |
| Custom OpenAI-compatible | `openai` | you supply it | none |
| Custom Anthropic-compatible | `anthropic` | you supply it | none |

`provider` is the **wire protocol**, not the vendor. Groq, DeepSeek, xAI, OpenRouter, Ollama,
and LM Studio all speak `openai`; only Anthropic speaks `anthropic`. Two things differ between
them: the auth header (`Authorization: Bearer` versus `x-api-key`), and how thinking levels map.

After the key is entered, `GET /v1/models` is called and the list becomes a picker. Both
protocols expose that endpoint with the same `data[].id` shape, so one code path handles both.
If the endpoint does not implement it, a preset with a known model list falls back to that;
otherwise you type the model id and setup still completes.

Anything the picker offers is a model the endpoint actually reports, which is more reliable than
a hard-coded list — that is why the fallback lists are short and only exist for Anthropic and
OpenAI.

## Cost estimates

`/cost` and the status bar price a turn from a table in `src/pricing.ts`, matched by longest
prefix on the model id, so `claude-sonnet-4-5-20250929` resolves via `claude-sonnet-4-5`. An
OpenRouter-style `anthropic/claude-sonnet-4-5` has its vendor prefix stripped first.

An unknown model is reported as unpriced rather than guessed:

```
4210 in / 88 out tokens (llama-3.3-70b is unpriced)
```

Two limits worth knowing. The rates are hand-entered and drift as vendors change them, so treat
the figure as an estimate, not a bill. And the token counts come from the provider's usage
report, while `~ctx` in the status bar is `JSON.stringify(messages).length / 4` — good enough to
decide when to compact, wrong enough that it should not be read as a token count.

## Environment variables

| Variable | Effect |
|---|---|
| `SHIRO_PROVIDER` | overrides `provider` |
| `SHIRO_MODEL` | overrides `model` |
| `SHIRO_BASE_URL` | overrides `baseURL` |
| `SHIRO_API_KEY` | overrides `apiKey` |
| `ANTHROPIC_API_KEY` | used when `provider` is `anthropic` and no key is set |
| `OPENAI_API_KEY` | used when `provider` is `openai` and no key is set |
| `SHIRO_HOME` | relocates config, sessions, memory, history, user skills, and installs |
| `SHIRO_INSTALL_DIR` | where `install:local` and the installers put the binary |
| `SHIRO_REPO` | which GitHub repo the installers download from |
| `SHIRO_VERSION` | pins the version the installers fetch |

`SHIRO_HOME` is what the test suite uses to keep a run out of your real config. It is also the
way to run two isolated setups side by side — a work profile and a personal one — since it moves
every piece of state at once:

```bash
SHIRO_HOME=~/work-shiro shiro
```

A key on the command line ends up in your shell history and in `ps`. `SHIRO_API_KEY` in front of
one command is better; `/provider` writing to `config.json` is better still.

## Flags

```
shiro [options]
shiro -p "prompt"          headless, prints to stdout
cat file | shiro -p        prompt read from stdin
```

| Flag | Effect |
|---|---|
| `-p`, `--print [prompt]` | headless mode. Needs `--yolo` for tool use |
| `--json` | with `-p`, one JSON event per line |
| `-c`, `--continue` | resume the newest session for this directory |
| `-r`, `--resume <id>` | resume by session id or unique prefix |
| `--agent <name>` | `default`, `quick`, `deep`, `plan`, `review` |
| `--think <level>` | `off`, `low`, `medium`, `high`, `max` |
| `--provider <name>` | `anthropic` or `openai` |
| `--model <id>` | model id |
| `--base-url <url>` | API root |
| `--no-mcp` | skip MCP servers |
| `--no-subagent` | omit the `task` tool |
| `--no-instructions` | ignore `AGENTS.md` and friends |
| `--no-skills` | ignore builtin, installed, and project skills |
| `--no-plugins` | disable all plugins, builtin and installed, including the guard |
| `--no-memory` | do not load or write project memory |
| `--yolo` | skip every approval prompt |
| `-v`, `--version` | version, bun version, platform, source or compiled |
| `-h`, `--help` | usage |

The `--no-*` flags exist for isolating a problem. All six together strip the agent to its
built-in tools and nothing else, which answers "is this the loop or something layered on it?"
in one run:

```bash
shiro --no-plugins --no-skills --no-memory --no-instructions --no-subagent --no-mcp
```

`--no-plugins` also disables the guard, so `rm -rf` becomes an ordinary approval prompt.
Reasonable while debugging, not something to leave on.

An unknown value fails at startup with the valid list rather than falling back silently:

```
$ shiro --agent turbo
shiro: Unknown agent "turbo". Available: default, quick, deep, plan, review
```

## Where things live

```
~/.shiro-neko/
  config.json                 provider, model, key, defaults
  sessions/<uuid>.json        transcripts, token counts, cost, task list
  memory/<hash>.json          durable per-project notes
  history/<hash>.json         prompt history for up-arrow recall
  skills/*.md                 your own skills
  registry/skills/*.md        skills installed with /registry
  registry/plugins/*.json     plugin manifests installed with /registry
```

Project files:

```
<project>/
  AGENTS.md                   instructions injected into the system prompt
  .shiro/skills/*.md          project skills, override user and builtin
  .shiroignore                extra ignore rules on top of .gitignore
```

Memory and history file names are SHA-256 prefixes of the absolute project path, because a
path is not a safe filename. Two consequences: moving a project loses its memory and history,
and two checkouts of the same repo at different paths keep separate ones.

## OpenAI reasoning models

Newer OpenAI models reject function tools on `/v1/chat/completions` and require
`/v1/responses`. For `api.openai.com` both are chained: a 400, 404, 405, 415, 422, or 501
on the first switches to the second, sticks for the rest of the session, and prints one
notice. Retryable failures — 429 and 5xx — are left to the SDK's backoff instead.

Only those six codes qualify, because they mean "this endpoint cannot serve this request shape".
A 401 is a wrong key and switching endpoints would only produce a second 401 with a more
confusing message.

The switch is sticky on purpose: once an endpoint rejects the shape it rejects every later step
too, so re-probing would waste a round trip per step of every turn.

Third-party endpoints get a plain chat-completions model with no fallback probe, since they
do not implement `/v1/responses`.

The two endpoints also differ in how they carry assistant history, which is where compaction gets
interesting — see [memory](memory.md#the-pruning-repair).

## Config that changes behaviour subtly

Four fields do more than they look like they do.

**`thinking`** costs money and latency on every turn, not just hard ones. `off` on a hard problem
produces confident wrong answers; `max` on a rename wastes cents and seconds. The agent variants
already pick sensible levels — see [agents](agents.md).

**`toolSets`** removes tools from the model's view entirely. If the agent stops using a tool you
expected, check the startup header for which sets loaded: an unrecognised name is dropped
silently, so `"gti"` reads as "git is off". See [tools](tools.md#tool-sets).

**`permission`** replaces a tool's defaults rather than merging with them, so
`{ "read_file": { "*": "allow" } }` also allows reading `.env`. Order inside a rule table decides
the outcome, since later rules win. See [permissions](permissions.md).

**`registryUrl`** is the whole trust decision for installed skills and plugins. There are no
signatures, so pointing it at an index means trusting whoever controls that URL — including for
whatever they publish later. See [registry](registry.md).
