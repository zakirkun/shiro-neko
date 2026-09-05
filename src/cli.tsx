#!/usr/bin/env bun
import { render } from 'ink';
import React from 'react';
import type { LanguageModel, ModelMessage } from 'ai';
import { resolveAgent, VARIANTS, isThinkingLevel, type AgentVariant } from './agents';
import { configPath, loadConfig, missingKeyMessage, resolveModel, writeConfigFile, type Config } from './config';
import type { FallbackEvent } from './fallback';
import { farewell } from './farewell';
import { readStdin, runHeadless } from './headless';
import { INIT_PROMPT, loadInstructions } from './instructions';
import { walk } from './ignore';
import { connectMcp } from './mcp';
import { createCommitMessageTool } from './commit';
import { Memory, KIND_LABEL } from './memory';
import { costOf } from './pricing';
import { BUILTIN_PLUGINS, DEFAULT_ENABLED } from './plugins-builtin';
import { createHost } from './plugins';
import { fetchModels, presetById } from './providers';
import * as registry from './registry';
import { Session } from './session';
import { loadSkills } from './skills';
import * as store from './store';
import { createTaskTool, type SubagentApproval } from './subagent';
import { VERSION, versionLine } from './version';
import { createAskBridge } from './ui/Ask';
import { App, createApprovalBridge, createNoticeBus, createSubagentBus, type AppHooks } from './ui/App';
import type { RegistryRow as AppRegistryRow } from './ui/Panels';

// SDK warnings go straight to stderr, which tears up the Ink render.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const HELP = `shiro-neko ${VERSION} - agentic coding CLI

usage: shiro [options]
       shiro -p "prompt"            headless, prints to stdout
       cat file | shiro -p          prompt read from stdin
options:
  -p, --print [prompt]            headless mode; requires --yolo for tool use
  --json                          with -p, emit one JSON event per line
  -c, --continue                  resume the newest session for this directory
  -r, --resume <id>               resume a session by id or id prefix
  --agent <name>                  ${VARIANTS.map((v) => v.name).join(' | ')}
  --think <level>                 off | low | medium | high | max
  --provider <anthropic|openai>   wire protocol to use (default anthropic)
  --model <id>                    model id
  --base-url <url>                OpenAI/Anthropic-compatible endpoint
  --no-mcp                        skip MCP servers from the config file
  --no-subagent                   omit the task tool
  --no-instructions               ignore AGENTS.md / CLAUDE.md
  --no-skills                     ignore builtin and project skills
  --no-plugins                    disable all plugins, including the guard
  --no-memory                     do not load or write project memory
  --yolo                          skip all tool approval prompts
  -v, --version
  -h, --help

first run: start shiro with no key and it opens provider setup, or use /provider anytime.

config: ${configPath()}
  { "provider": "openai", "model": "gpt-5", "apiKey": "...",
    "agent": "default", "thinking": "medium", "plugins": ["guard", "time"],
    "toolSets": ["edit-plus", "git"], "registryUrl": "https://...",
    "permission": { "bash": { "*": "ask", "git *": "allow" } },
    "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }

env:    SHIRO_PROVIDER SHIRO_MODEL SHIRO_BASE_URL SHIRO_API_KEY
        ANTHROPIC_API_KEY OPENAI_API_KEY

skills:   builtin, plus ~/.shiro-neko/skills/*.md and .shiro/skills/*.md
registry: /registry to browse and install external skills and plugins
mcp:      /mcp to add a local or remote server, or list what is configured
sessions: ${store.sessionsDir()}
in-session: /help for the command list`;

const argv = process.argv.slice(2);

function flag(...names: string[]): string | undefined {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i === -1) continue;
    const next = argv[i + 1];
    return next && !next.startsWith('-') ? next : '';
  }
  return undefined;
}

const has = (...names: string[]) => names.some((n) => argv.includes(n));

if (has('-h', '--help')) {
  console.log(HELP);
  process.exit(0);
}

if (has('-v', '--version')) {
  console.log(versionLine());
  process.exit(0);
}

const providerFlag = flag('--provider');
const modelFlag = flag('--model');
const baseUrlFlag = flag('--base-url');
if (providerFlag) process.env['SHIRO_PROVIDER'] = providerFlag;
if (modelFlag) process.env['SHIRO_MODEL'] = modelFlag;
if (baseUrlFlag) process.env['SHIRO_BASE_URL'] = baseUrlFlag;

let cfg = await loadConfig();
const yolo = has('--yolo');
const headless = flag('-p', '--print') !== undefined;

// A missing key is fatal for a pipe, but interactively it just means "not set up yet".
if (!cfg.apiKey && headless) {
  console.error(`shiro: ${missingKeyMessage(cfg.provider)}`);
  process.exit(1);
}

const needsProvider = !cfg.apiKey;
const notices = createNoticeBus();
const subagents = createSubagentBus();
const askBridge = createAskBridge();

function reportFallback(e: FallbackEvent): void {
  const line = `endpoint fallback: ${e.from} rejected the request, retrying on ${e.to}\n  ${e.reason}`;
  if (headless) process.stderr.write(`shiro: ${line}\n`);
  else notices.emit(line);
}

let languageModel: LanguageModel | undefined;
if (cfg.apiKey) {
  try {
    languageModel = resolveModel(cfg, reportFallback);
  } catch (e) {
    console.error(`shiro: ${(e as Error).message}`);
    process.exit(1);
  }
}

let restored: store.SessionRecord | undefined;
const resumeArg = flag('-r', '--resume');
if (resumeArg) {
  const id = await store.resolveId(resumeArg);
  restored = id ? await store.load(id) : undefined;
  if (!restored) {
    console.error(`shiro: no session matching "${resumeArg}"`);
    process.exit(1);
  }
} else if (has('-c', '--continue')) {
  restored = await store.latest(process.cwd());
  if (!restored) {
    console.error('shiro: no saved session for this directory');
    process.exit(1);
  }
}

const mcp = has('--no-mcp') || !cfg.mcpServers ? undefined : await connectMcp(cfg.mcpServers);
const instructions = has('--no-instructions') ? [] : await loadInstructions();
const skills = has('--no-skills') ? [] : await loadSkills();
const promptHistory = await store.loadHistory();

const installedPlugins = has('--no-plugins') ? { plugins: [], errors: [] } : await registry.loadInstalledPlugins();

/** Installed entries, as `kind:name`, so the registry list can mark what is already here. */
async function installedNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const s of skills) if (s.origin === 'registry') names.add(`skill:${s.name}`);
  for (const p of installedPlugins.plugins) names.add(`plugin:${p.name}`);
  return names;
}

/**
 * One entry by name, from the index.
 *
 * A name alone is ambiguous when a skill and a plugin share it, so `skill:name`
 * disambiguates. Asking rather than guessing would be worse here: the two differ in
 * what they can do, and picking one silently is the wrong default.
 */
async function findEntry(name: string): Promise<registry.RegistryEntry> {
  const parsed = /^(skill|plugin):(.+)$/.exec(name.trim());
  const kind = parsed?.[1] as registry.RegistryKind | undefined;
  const bare = (parsed?.[2] ?? name).trim().toLowerCase();

  const entries = await registry.fetchIndex(cfg.registryUrl);
  const hits = entries.filter((e) => e.name === bare && (kind === undefined || e.kind === kind));

  if (hits.length === 0) throw new Error(`no registry entry named "${bare}". Try /registry search ${bare}`);
  if (hits.length > 1) {
    throw new Error(
      `"${bare}" is both a skill and a plugin. Use /registry add skill:${bare} or /registry add plugin:${bare}`,
    );
  }
  return hits[0]!;
}

let agentVariant: AgentVariant;
try {
  agentVariant = resolveAgent(flag('--agent') || cfg.agent, flag('--think') || cfg.thinking);
} catch (e) {
  console.error(`shiro: ${(e as Error).message}`);
  process.exit(1);
}

const enabledPlugins = has('--no-plugins') ? [] : (cfg.plugins ?? DEFAULT_ENABLED);
const pluginErrors = enabledPlugins
  .filter((name) => !BUILTIN_PLUGINS.some((p) => p.name === name))
  .map((name) => ({ plugin: name, message: 'no such plugin' }));
const plugins = createHost(
  [...BUILTIN_PLUGINS.filter((p) => enabledPlugins.includes(p.name)), ...installedPlugins.plugins],
  [...pluginErrors, ...installedPlugins.errors],
);

const memory = has('--no-memory') ? undefined : new Memory(process.cwd(), languageModel);
if (memory) await memory.load();

/** Placeholder until /provider supplies a key; it never gets called because the UI gates input. */
const unconfiguredModel: LanguageModel = {
  specificationVersion: 'v4',
  provider: 'unconfigured',
  modelId: 'unconfigured',
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error('no provider configured - run /provider')),
  doStream: () => Promise.reject(new Error('no provider configured - run /provider')),
};

const record: store.SessionRecord = restored ?? {
  id: store.newId(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cwd: process.cwd(),
  provider: cfg.provider,
  model: cfg.model,
  title: 'untitled',
  inputTokens: 0,
  outputTokens: 0,
  messages: [],
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;

async function persist(messages: ModelMessage[]): Promise<void> {
  record.messages = messages;
  record.title = store.titleOf(messages);
  record.inputTokens = session.inputTokens;
  record.outputTokens = session.outputTokens;
  record.notebook = session.notebook.state();
  const cost = costOf(record.model, session.inputTokens, session.outputTokens);
  if (cost !== undefined) record.costUsd = cost;
  await store.save(record);
}

const bridge = createApprovalBridge();

/**
 * Late-bound so the task tool can be built before the Session that owns the gate.
 *
 * `createTaskTool` decides whether to offer the `worker` kind from whether an
 * approval channel exists, so the callback has to be present at construction even
 * though the Session it delegates to does not exist yet.
 */
let approveSubagent: SubagentApproval | undefined;
const subagentGate: SubagentApproval = (req) => {
  if (!approveSubagent) throw new Error('the subagent approval channel is not wired yet');
  return approveSubagent(req);
};

const session = new Session({
  model: languageModel ?? unconfiguredModel,
  askApproval: bridge.ask,
  yolo,
  instructions,
  skills,
  plugins,
  agent: agentVariant,
  ...(cfg.toolSets ? { toolSets: cfg.toolSets } : {}),
  ...(cfg.permission ? { permissions: cfg.permission } : {}),
  // Headless has no one to answer, so the tool is withheld rather than left to hang.
  ...(headless ? {} : { ask: askBridge.ask }),
  ...(memory ? { memory } : {}),
  ...(record.notebook ? { notebook: record.notebook } : {}),
  ...(cfg.maxRetries !== undefined ? { maxRetries: cfg.maxRetries } : {}),
  extraTools: {
    ...(mcp?.tools ?? {}),
    git_commit_message: createCommitMessageTool({
      model: languageModel ?? unconfiguredModel,
      ...(headless ? {} : { cwd: process.cwd() }),
    }),
    ...(has('--no-subagent')
      ? {}
      : {
          task: createTaskTool({
            model: languageModel ?? unconfiguredModel,
            ...(headless ? {} : { report: subagents.emit }),
            // A worker's writes go through the parent's rules and the parent's
            // prompt. Headless has nobody to answer, so `worker` is withheld there
            // rather than silently running unattended writes.
            ...(headless ? {} : { approve: subagentGate }),
          }),
        }),
  },
  autoApprove: ['task', 'git_commit_message'],
  messages: [...record.messages],
  onChange: (messages) => {
    // Debounced so a long tool loop does not hit the disk on every step.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persist(messages), 400);
  },
});

approveSubagent = session.approveForSubagent();

async function shutdown(code: number): Promise<never> {
  clearTimeout(saveTimer);
  if (session.messages.length > 0) await persist(session.messages);
  await mcp?.close();
  process.exit(code);
}
const printArg = flag('-p', '--print');
if (printArg !== undefined) {
  const prompt = printArg || (await readStdin());
  if (!prompt) {
    console.error('shiro: -p needs a prompt argument or piped stdin');
    await shutdown(1);
  }
  if (!yolo) {
    process.stderr.write(
      'shiro: headless denies write_file, edit_file, multi_edit, bash and mcp tools unless --yolo is passed\n',
    );
  }
  const code = await runHeadless({ session, prompt, format: has('--json') ? 'json' : 'text' });
  await shutdown(code);
}

function applyConfig(next: Config): void {
  cfg = next;
  record.provider = next.provider;
  record.model = next.model;
  session.setModel(resolveModel(next, reportFallback));
}

const hooks: AppHooks = {
  sessionId: record.id,
  config: () => cfg,
  instructionFiles: () => instructions.map((i) => i.path),
  listPaths: async () => {
    const found: string[] = [];
    for await (const rel of walk({ limit: 5000 })) found.push(rel);
    return found;
  },
  registry: {
    list: async () => {
      const entries = await registry.fetchIndex(cfg.registryUrl);
      const installed = await installedNames();
      return entries.map((e) => ({
        name: e.name,
        kind: e.kind,
        description: e.description,
        ...(e.author ? { author: e.author } : {}),
        installed: installed.has(`${e.kind}:${e.name}`),
      }));
    },
    installed: async () => {
      const rows: AppRegistryRow[] = [];
      for (const s of skills) {
        if (s.origin === 'registry') rows.push({ name: s.name, kind: 'skill', description: s.description, installed: true });
      }
      for (const p of installedPlugins.plugins) {
        rows.push({ name: p.name, kind: 'plugin', description: p.description, installed: true });
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    },
    stage: async (name) => {
      const entry = await findEntry(name);
      const { preview } = await registry.stage(entry);
      return {
        row: { name: entry.name, kind: entry.kind, description: entry.description },
        url: entry.url,
        preview,
      };
    },
    install: async (name) => {
      const entry = await findEntry(name);
      const { path } = await registry.install(entry);
      // Loaded on the next start rather than hot-swapped: a skill joins the system
      // prompt and a plugin joins the guard chain, and both are built once at boot.
      return `installed ${entry.kind} ${entry.name} to ${path}\nrestart shiro to load it`;
    },
    remove: async (name) => {
      const parsed = /^(skill|plugin):(.+)$/.exec(name);
      const kinds: registry.RegistryKind[] = parsed ? [parsed[1] as registry.RegistryKind] : ['skill', 'plugin'];
      const bare = parsed ? parsed[2]! : name;

      for (const kind of kinds) {
        if (await registry.uninstall(kind, bare)) return `removed ${kind} ${bare}\nrestart shiro to unload it`;
      }
      throw new Error(`nothing installed under the name "${bare}"`);
    },
  },
  mcp: {
    names: () => Object.keys(cfg.mcpServers ?? {}),
    list: () => {
      const servers = Object.entries(cfg.mcpServers ?? {});
      if (servers.length === 0) return 'no MCP servers configured\n\n`/mcp add` sets one up.';

      const live = new Map<string, number>();
      for (const name of Object.keys(mcp?.tools ?? {})) {
        const server = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(name)?.[1];
        if (server) live.set(server, (live.get(server) ?? 0) + 1);
      }
      const failed = new Map((mcp?.errors ?? []).map((e) => [e.server, e.message]));

      const rows = servers.map(([name, config]) => {
        const where = 'url' in config ? config.url : [config.command, ...(config.args ?? [])].join(' ');
        const state = failed.has(name)
          ? `failed: ${failed.get(name)}`
          : live.has(name)
            ? `${live.get(name)} tools`
            : has('--no-mcp')
              ? 'not connected (--no-mcp)'
              : 'not connected this session';
        return `- \`${name}\` (${'url' in config ? 'remote' : 'local'}) - ${state}\n  ${where}`;
      });

      return [...rows, '', `configured in ${configPath()}`].join('\n');
    },
    add: async (result) => {
      const servers = { ...(cfg.mcpServers ?? {}), [result.name]: result.config };
      cfg = { ...cfg, mcpServers: servers };
      const path = await writeConfigFile({ mcpServers: servers });
      const where = 'url' in result.config ? result.config.url : result.config.command;
      // Connected at boot, like the servers already in the file: a mid-turn connect
      // would change the tool list under a turn that is already running.
      return `added mcp server ${result.name} (${where})\nsaved to ${path}\nrestart shiro to connect it`;
    },
    remove: async (name) => {
      const servers = { ...(cfg.mcpServers ?? {}) };
      if (!(name in servers)) throw new Error(`no MCP server named "${name}"`);
      delete servers[name];
      cfg = { ...cfg, mcpServers: servers };
      const path = await writeConfigFile({ mcpServers: servers });
      return `removed mcp server ${name}\nsaved to ${path}\nrestart shiro to disconnect it`;
    },
  },
  initPrompt: INIT_PROMPT,
  history: promptHistory,
  recordPrompt: (text) => void store.appendHistory(text),
  agentName: () => session.agent().name,
  thinkingLevel: () => session.agent().thinking,
  switchModel: (id) => {
    applyConfig({ ...cfg, model: id });
    return `model is now ${id}`;
  },
  switchAgent: (name) => {
    const next = resolveAgent(name, session.agent().thinking);
    session.setAgent(next);
    const scope = next.allowTools ? ` (read-only: ${next.allowTools.length} tools)` : '';
    return `agent is now ${next.name}, thinking ${next.thinking}${scope}`;
  },
  switchThinking: (level) => {
    if (!isThinkingLevel(level)) throw new Error(`Unknown thinking level "${level}"`);
    session.setAgent({ ...session.agent(), thinking: level });
    return `thinking is now ${level}`;
  },
  listSkills: () => {
    if (skills.length === 0) return 'no skills loaded';
    return [
      ...skills.map((s) => `${s.name.padEnd(12)} ${s.origin.padEnd(9)} ${s.description}`),
      '',
      '`/registry` to browse and install more',
    ].join('\n');
  },
  listPlugins: () => {
    const active = plugins.plugins.map((p) => `${p.name.padEnd(12)} ${p.description}`);
    const failed = plugins.errors.map((e) => `${e.plugin.padEnd(12)} ${e.message}`);
    if (active.length === 0 && failed.length === 0) return 'no plugins active';
    return [...active, ...failed, '', '`/registry` to browse and install more'].join('\n');
  },
  listMemory: async () => {
    if (!memory) return 'memory is disabled (--no-memory)';
    const all = await memory.load();
    if (all.length === 0) return 'nothing remembered about this project yet';
    return all
      .slice()
      .reverse()
      .map((e) => `(${KIND_LABEL[e.kind]}) ${e.text}${e.hits > 0 ? `  [recalled ${e.hits}x]` : ''}`)
      .join('\n');
  },
  summarizeMemory: async () => {
    if (!memory) return 'memory is disabled (--no-memory)';
    const { before, after } = await memory.summarize();
    return before === after
      ? `memory left as is: ${before} entries, too few unused ones to merge`
      : `memory compacted: ${before} entries into ${after}`;
  },
  applyProvider: async (result) => {
    const next: Config = {
      ...cfg,
      provider: result.provider,
      model: result.model,
      baseURL: result.baseURL,
      apiKey: result.apiKey,
      presetId: result.presetId,
    };
    applyConfig(next);
    const path = await writeConfigFile({
      provider: next.provider,
      model: next.model,
      baseURL: next.baseURL,
      apiKey: next.apiKey,
      presetId: next.presetId,
    });
    const label = presetById(result.presetId)?.label ?? result.presetId;
    return `${label} configured with ${result.model}\nsaved to ${path}`;
  },
  listModels: async () => {
    if (!cfg.apiKey) return { models: [], warning: 'no API key set - run /provider' };
    const preset = presetById(cfg.presetId ?? cfg.provider);
    const { models, warning } = await fetchModels(
      {
        kind: cfg.provider,
        baseURL: cfg.baseURL ?? '',
        ...(preset?.fallbackModels ? { fallbackModels: preset.fallbackModels } : {}),
      },
      cfg.apiKey,
    );
    return warning ? { models, warning } : { models };
  },
  listSessions: async () => {
    const all = await store.list(15);
    if (all.length === 0) return 'no saved sessions';
    return all
      .map(
        (r) =>
          `${r.id.slice(0, 8)}  ${r.updatedAt.slice(0, 16).replace('T', ' ')}  ${r.messages.length}msg  ${r.title}`,
      )
      .join('\n');
  },
  resumeSession: async (idOrPrefix) => {
    const id = await store.resolveId(idOrPrefix);
    const rec = id ? await store.load(id) : undefined;
    if (!rec) throw new Error(`no session matching "${idOrPrefix}"`);
    session.replace(rec.messages);
    record.id = rec.id;
    record.title = rec.title;
    hooks.sessionId = rec.id;
    return `resumed ${rec.id.slice(0, 8)} (${rec.messages.length} messages): ${rec.title}`;
  },
  saveSession: async () => {
    await persist(session.messages);
    return `saved ${record.id}`;
  },
};

const header = [
  needsProvider
    ? `shiro-neko ${VERSION}  no provider configured`
    : `shiro-neko ${VERSION}  ${cfg.provider}/${record.model}  session ${record.id.slice(0, 8)}`,
  `agent: ${agentVariant.name}  thinking: ${agentVariant.thinking}`,
  `cwd: ${process.cwd()}`,
  restored ? `resumed ${record.messages.length} messages` : undefined,
  instructions.length > 0
    ? `instructions: ${instructions.map((i) => i.path.split(/[\\/]/).at(-1)).join(', ')}`
    : 'no AGENTS.md found - /init writes one',
  skills.length > 0 ? `skills: ${skills.map((s) => s.name).join(', ')}` : undefined,
  plugins.plugins.length > 0 ? `plugins: ${plugins.plugins.map((p) => p.name).join(', ')}` : undefined,
  ...plugins.errors.map((e) => `plugin ${e.plugin}: ${e.message}`),
  memory && memory.all().length > 0 ? `memory: ${memory.all().length} notes about this project` : undefined,
  mcp && Object.keys(mcp.tools).length > 0 ? `mcp: ${Object.keys(mcp.tools).length} tools` : undefined,
  !mcp && cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0
    ? `mcp: ${Object.keys(cfg.mcpServers).length} configured, not connected (--no-mcp)`
    : undefined,
  ...(mcp?.errors ?? []).map((e) => `mcp ${e.server} failed: ${e.message}`),
  yolo
    ? 'approvals: OFF (--yolo), but deny rules and the guard still apply'
    : cfg.permission
      ? `approvals: rules for ${Object.keys(cfg.permission).join(', ')}, defaults elsewhere`
      : 'approvals: ask for write_file, edit_file, multi_edit, apply_patch, move_file, delete_file, bash, web_fetch, mcp__*',
  cfg.toolSets ? `tool sets: core, ${cfg.toolSets.join(', ')}` : undefined,
  '/help for commands',
]
  .filter(Boolean)
  .join('\n');

// ctrl-c has to reach the App: with a command running it kills that command and
// keeps the turn. Ink's own handler would exit the process before we saw the key.
const app = render(
  <App
    session={session}
    bridge={bridge}
    header={header}
    hooks={hooks}
    notices={notices}
    askBridge={askBridge}
    subagents={subagents}
    needsProvider={needsProvider}
  />,
  { exitOnCtrlC: false },
);
await app.waitUntilExit();
// Printed after Ink has released the screen, so it survives the final repaint. The
// title comes from the messages rather than `record`, whose own title is only
// refreshed by the debounced save and may not have run yet.
console.log(
  farewell({
    id: record.id,
    messages: session.messages.length,
    title: store.titleOf(session.messages),
  }),
);
await shutdown(0);
