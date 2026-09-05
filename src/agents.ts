export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** Maps our vocabulary to the SDK's, which each provider then maps to its own knob. */
const SDK_REASONING: Record<ThinkingLevel, 'none' | 'low' | 'medium' | 'high' | 'xhigh'> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
};

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

export const isThinkingLevel = (v: string): v is ThinkingLevel => (THINKING_LEVELS as string[]).includes(v);

export const sdkReasoning = (level: ThinkingLevel) => SDK_REASONING[level];

export type AgentVariant = {
  name: string;
  summary: string;
  thinking: ThinkingLevel;
  /** Appended to the system prompt to shape behaviour. */
  appendix: string;
  /** When set, only these tools are offered. Omit to offer everything. */
  allowTools?: readonly string[];
  maxSteps?: number;
};

const READ_ONLY = [
  'read_file',
  'read_many_files',
  'glob',
  'grep',
  'list_dir',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'git_branch',
  'git_commit_message',
  'task',
  'web_fetch',
  'todo_write',
  'remember',
  'recall',
  'skill',
] as const;

export const VARIANTS: AgentVariant[] = [
  {
    name: 'default',
    summary: 'balanced: full tools, medium thinking',
    thinking: 'medium',
    appendix: '',
  },
  {
    name: 'quick',
    summary: 'small edits: no thinking budget, act immediately',
    thinking: 'off',
    maxSteps: 12,
    appendix:
      'This is a small, well-scoped task. Do not deliberate: locate the code, make the change, verify it. ' +
      'Do not write a task list. Do not explore beyond what the change requires.',
  },
  {
    name: 'deep',
    summary: 'hard problems: maximum thinking, more steps',
    thinking: 'max',
    maxSteps: 80,
    appendix:
      'This task is hard or its cause is unclear. Form more than one hypothesis before you act and say which one ' +
      'you are testing. Read enough of the code to be sure rather than guessing. Record findings with remember ' +
      'so they survive compaction. Report what you verified and what you could not.',
  },
  {
    name: 'plan',
    summary: 'read-only: investigate and propose, never edit',
    thinking: 'high',
    allowTools: READ_ONLY,
    appendix:
      'You are in planning mode and have no tools that change anything. Investigate, then produce a plan: ' +
      'the files to touch, the change in each, the order, and how to verify. Flag anything ambiguous instead of ' +
      'assuming. Do not describe edits as if you had made them.',
  },
  {
    name: 'review',
    summary: 'read-only: critique a change, find defects',
    thinking: 'high',
    allowTools: READ_ONLY,
    appendix:
      'You are reviewing code, not writing it. Look for defects in this order: incorrect behaviour, missing error ' +
      'handling at trust boundaries, security issues, then clarity. For each finding give file, line, why it is ' +
      'wrong, and the fix. Say plainly when something is fine. Do not invent problems to fill a report.',
  },
];

export const DEFAULT_VARIANT = VARIANTS[0]!;

export const variantByName = (name: string) => VARIANTS.find((v) => v.name === name);

/** Variant with an explicit thinking override applied, for `--agent deep --think low`. */
export function resolveAgent(name: string | undefined, thinking: string | undefined): AgentVariant {
  const base = name ? variantByName(name) : DEFAULT_VARIANT;
  if (!base) throw new Error(`Unknown agent "${name}". Available: ${VARIANTS.map((v) => v.name).join(', ')}`);
  if (thinking === undefined) return base;
  if (!isThinkingLevel(thinking)) {
    throw new Error(`Unknown thinking level "${thinking}". Available: ${THINKING_LEVELS.join(', ')}`);
  }
  return { ...base, thinking };
}

export function renderAgent(variant: AgentVariant): string {
  return variant.appendix ? `\n${variant.appendix}` : '';
}
