export type CommandAction =
  | { type: 'none' }
  | { type: 'prompt'; text: string }
  | { type: 'exit' }
  | { type: 'clear' }
  | { type: 'compact' }
  | { type: 'tools' }
  | { type: 'cost' }
  | { type: 'sessions' }
  | { type: 'save' }
  | { type: 'provider' }
  | { type: 'models' }
  | { type: 'init' }
  | { type: 'context' }
  | { type: 'todos' }
  | { type: 'notes' }
  | { type: 'skills' }
  | { type: 'plugins' }
  | { type: 'registry'; action: 'list' | 'search' | 'add' | 'remove' | 'installed'; arg?: string }
  | { type: 'mcp'; action: 'list' | 'add' | 'remove'; arg?: string }
  | { type: 'memory' }
  | { type: 'agent'; agent?: string }
  | { type: 'think'; level?: string }
  | { type: 'info'; text: string }
  | { type: 'model'; model: string }
  | { type: 'resume'; id: string }
  | { type: 'unknown'; name: string };

export type CommandSpec = {
  name: string;
  /** Extra names that resolve to the same command, hidden from the menu. */
  aliases?: string[];
  arg?: string;
  summary: string;
};

/** Single source of truth for the menu, `/help`, and the parser. */
export const COMMANDS: CommandSpec[] = [
  { name: 'help', aliases: ['?'], summary: 'list these commands' },
  { name: 'agent', arg: '[name]', summary: 'switch agent: default, quick, deep, plan, review' },
  { name: 'think', arg: '[level]', summary: 'thinking level: off, low, medium, high, max' },
  { name: 'provider', aliases: ['login'], summary: 'set up a provider: pick, paste API key, choose model' },
  { name: 'models', summary: 'pick a model from the current provider' },
  { name: 'model', arg: '<id>', summary: 'switch model by name' },
  { name: 'skills', summary: 'list loaded skills' },
  { name: 'plugins', summary: 'list active plugins' },
  { name: 'registry', arg: '[search|add|remove] [name]', summary: 'browse and install external skills and plugins' },
  { name: 'mcp', arg: '[add|remove <name>]', summary: 'add a local or remote MCP server, or list them' },
  { name: 'init', summary: 'have the agent write AGENTS.md for this project' },
  { name: 'context', summary: 'show which instruction files are loaded' },
  { name: 'todos', summary: "show the agent's task list" },
  { name: 'notes', summary: 'show what the agent remembers about this project' },
  { name: 'memory', summary: 'compact the project memory with the model' },
  { name: 'tools', summary: 'list available tools' },
  { name: 'compact', summary: 'replace history with a model-written summary' },
  { name: 'cost', summary: 'tokens and estimated spend this session' },
  { name: 'sessions', summary: 'list saved sessions' },
  { name: 'resume', arg: '<id>', summary: 'load a saved session' },
  { name: 'save', summary: 'write the session to disk now' },
  { name: 'clear', summary: 'clear the transcript and history' },
  { name: 'exit', aliases: ['quit'], summary: 'quit' },
];

const usage = (c: CommandSpec) => `/${c.name}${c.arg ? ` ${c.arg}` : ''}`;

export const HELP = [
  ...COMMANDS.map((c) => `${usage(c).padEnd(22)} ${c.summary}`),
  '',
  'esc                    interrupt the running turn and clear the queue',
  'ctrl-c                 kill the running command, keeping the turn',
  'ctrl-r                 expand or collapse the reasoning panel',
  'tab                    complete the highlighted command or file path',
  'up / down              recall earlier prompts, or move in an open menu',
  '@                      complete a workspace path',
  '',
  'typing during a turn queues the prompt; queued prompts run in order afterwards',
].join('\n');

/**
 * Commands whose name starts with the typed prefix, for the `/` menu.
 * An exact name sorts first so pressing enter on `/model` cannot run `/models`.
 * Aliases stay hidden to keep the list short.
 */
export function matchCommands(input: string): CommandSpec[] {
  if (!input.startsWith('/')) return [];
  const typed = input.slice(1).toLowerCase();
  if (typed.includes(' ')) return [];
  const hits = COMMANDS.filter((c) => c.name.startsWith(typed));
  const exact = hits.findIndex((c) => c.name === typed);
  return exact > 0 ? [hits[exact]!, ...hits.filter((_, i) => i !== exact)] : hits;
}

/** True while the input is a bare command name being typed, so the menu should show. */
export const isMenuOpen = (input: string) => input.startsWith('/') && !input.includes(' ');

/**
 * `/registry [list|installed|search <q>|add <name>|remove <name>]`.
 *
 * A bare `/registry` lists everything. `add` and `remove` need a name, and saying
 * so beats fetching the whole index to then complain.
 */
function parseRegistry(arg: string): CommandAction {
  const [verb = '', ...rest] = arg.split(/\s+/).filter(Boolean);
  const name = rest.join(' ').trim();

  switch (verb) {
    case '':
    case 'list':
      return { type: 'registry', action: 'list' };
    case 'installed':
      return { type: 'registry', action: 'installed' };
    case 'search':
      return name
        ? { type: 'registry', action: 'search', arg: name }
        : { type: 'info', text: 'usage: /registry search <query>' };
    case 'add':
    case 'install':
      return name
        ? { type: 'registry', action: 'add', arg: name }
        : { type: 'info', text: 'usage: /registry add <name>' };
    case 'remove':
    case 'uninstall':
      return name
        ? { type: 'registry', action: 'remove', arg: name }
        : { type: 'info', text: 'usage: /registry remove <name>' };
    default:
      // A bare word is almost always a search, and guessing beats a usage line.
      return { type: 'registry', action: 'search', arg: arg.trim() };
  }
}

/**
 * `/mcp [list|add|remove <name>]`.
 *
 * A bare `/mcp` lists what is configured, because that is the question asked most
 * often. `add` opens the wizard rather than taking arguments: a server is a name
 * plus a command or a URL plus optional headers, and a single argument string
 * cannot express that without a syntax nobody remembers.
 */
function parseMcp(arg: string): CommandAction {
  const [verb = '', ...rest] = arg.split(/\s+/).filter(Boolean);
  const name = rest.join(' ').trim();

  switch (verb) {
    case '':
    case 'list':
      return { type: 'mcp', action: 'list' };
    case 'add':
    case 'new':
      return { type: 'mcp', action: 'add' };
    case 'remove':
    case 'rm':
      return name ? { type: 'mcp', action: 'remove', arg: name } : { type: 'info', text: 'usage: /mcp remove <name>' };
    default:
      return { type: 'info', text: 'usage: /mcp [list|add|remove <name>]' };
  }
}

/** Pure parser: no IO, so the TUI and headless mode share one definition. */
export function parseCommand(raw: string): CommandAction {
  const input = raw.trim();
  if (!input) return { type: 'none' };
  if (!input.startsWith('/')) return { type: 'prompt', text: input };

  const [name = '', ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (name) {
    case 'help':
    case '?':
      return { type: 'info', text: HELP };
    case 'exit':
    case 'quit':
      return { type: 'exit' };
    case 'clear':
      return { type: 'clear' };
    case 'compact':
      return { type: 'compact' };
    case 'tools':
      return { type: 'tools' };
    case 'cost':
      return { type: 'cost' };
    case 'sessions':
      return { type: 'sessions' };
    case 'save':
      return { type: 'save' };
    case 'provider':
    case 'login':
      return { type: 'provider' };
    case 'models':
      return { type: 'models' };
    case 'init':
      return { type: 'init' };
    case 'context':
      return { type: 'context' };
    case 'todos':
      return { type: 'todos' };
    case 'notes':
      return { type: 'notes' };
    case 'skills':
      return { type: 'skills' };
    case 'plugins':
      return { type: 'plugins' };
    case 'registry':
      return parseRegistry(arg);
    case 'mcp':
      return parseMcp(arg);
    case 'memory':
      return { type: 'memory' };
    case 'agent':
      return arg ? { type: 'agent', agent: arg } : { type: 'agent' };
    case 'think':
      return arg ? { type: 'think', level: arg } : { type: 'think' };
    case 'model':
      return arg ? { type: 'model', model: arg } : { type: 'models' };
    case 'resume':
      return arg ? { type: 'resume', id: arg } : { type: 'info', text: 'usage: /resume <session-id>' };
    default:
      return { type: 'unknown', name };
  }
}
