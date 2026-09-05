import {
  isStepCount,
  generateText,
  streamText,
  APICallError,
  type LanguageModel,
  type ModelMessage,
  type ToolApprovalResponse,
  type ToolSet,
} from 'ai';
import { DEFAULT_VARIANT, sdkReasoning, renderAgent, type AgentVariant } from './agents';
import { createAskTool, type AskFn } from './ask';
import type { Instructions } from './instructions';
import type { Memory } from './memory';
import { Notebook, type NotebookState } from './notebook';
import { Permissions, type PermissionConfig } from './permission';
import type { PluginHost } from './plugins';
import { systemPrompt } from './prompt';
import { detachProviderItems, pruneToFit } from './prune';
import { createSkillTool, renderSkills, type Skill } from './skills';
import { disabledToolNames, onBashOutput, tools as builtinTools, type ToolSetName } from './tools';

export type ApprovalRequest = {
  approvalId: string;
  toolName: string;
  input: unknown;
  /** The rule that decided this needs asking, when one did. */
  matchedPattern?: string;
  /** What `always` would whitelist, e.g. `git *` rather than every bash call. */
  suggestedPattern: string;
  /** Set when the call is being asked about because it repeated, not because of a rule. */
  repeated?: boolean;
  /** Set when a `worker` subagent is asking, not the main agent. */
  subagent?: boolean;
};

/** 'once' runs this call only; 'always' whitelists the suggested pattern for the session. */
export type ApprovalDecision = 'once' | 'always' | 'deny';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; id: string; name: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-output'; id: string; chunk: string }
  | { type: 'tool-result'; id: string; name: string; output: unknown }
  | { type: 'tool-error'; id: string; name: string; error: unknown }
  | { type: 'tool-denied'; name: string }
  | { type: 'compacted'; before: number; after: number }
  | { type: 'notice'; text: string }
  | { type: 'error'; error: unknown }
  | { type: 'done'; inputTokens?: number; outputTokens?: number };

export type SessionOptions = {
  model: LanguageModel;
  askApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  yolo?: boolean;
  cwd?: string;
  maxSteps?: number;
  /** MCP and subagent tools merged on top of the built-ins. */
  extraTools?: ToolSet;
  /** Tool sets offered this session; omit for all of them. `core` is always on. */
  toolSets?: readonly ToolSetName[];
  /** Rules deciding which calls run, ask, or are refused. Omit for the defaults. */
  permissions?: PermissionConfig;
  /** Tool names that never prompt, e.g. the read-only subagent tool. */
  autoApprove?: readonly string[];
  /** Prune the history once the estimated token count crosses this. */
  compactThreshold?: number;
  /** Retries per model call for transient failures. */
  maxRetries?: number;
  /** AGENTS.md-style files appended to the system prompt. */
  instructions?: Instructions;
  /** Task list restored from a resumed session. */
  notebook?: NotebookState;
  /** Thinking level, tool restrictions, and behaviour appendix. */
  agent?: AgentVariant;
  skills?: Skill[];
  memory?: Memory;
  plugins?: PluginHost;
  /** Where an `ask` tool call goes. Omit in headless runs. */
  ask?: AskFn;
  messages?: ModelMessage[];
  onChange?: (messages: ModelMessage[]) => void;
  /** Live stdout/stderr from bash, for a UI that wants progress. */
  onToolOutput?: (id: string, chunk: string) => void;
  onNotebookChange?: (state: NotebookState) => void;
};

const estimateTokens = (messages: ModelMessage[]) => Math.round(JSON.stringify(messages).length / 4);

/** Estimated tokens at which the wire history is pruned. */
const DEFAULT_COMPACT_THRESHOLD = 120_000;

/** Identical calls in one turn before an allowed tool is asked about anyway. */
const REPEAT_LIMIT = 3;

const callKey = (toolName: string, input: unknown) => `${toolName}:${JSON.stringify(input ?? null)}`;

/**
 * The provider rejected an `item_reference` because it no longer holds that item:
 * 404 "Item with id 'msg_...' not found". Retrying the same history repeats it, so
 * this is the one failure that is worth answering by rewriting the history.
 */
const isStaleItemError = (error: unknown): boolean =>
  APICallError.isInstance(error) && /item with id '[^']*' not found/i.test(error.message);

const STALE_ITEM_NOTICE =
  'The provider no longer had part of this session stored. Re-sent the history inline and carried on.';

type ApprovalContext = Pick<ApprovalRequest, 'matchedPattern' | 'suggestedPattern' | 'repeated'>;

export class Session {
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly notebook: Notebook;
  inputTokens = 0;
  outputTokens = 0;
  private model: LanguageModel;
  private variant: AgentVariant;
  private readonly permissions: Permissions;
  /** Calls seen this turn, for the repeat guard. Cleared per turn, not per step. */
  private readonly seen = new Map<string, number>();
  /** One stale-item repair per turn, so a repeating 404 cannot loop the run. */
  private staleItemsRepaired = false;
  private controller: AbortController | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.messages = opts.messages ?? [];
    this.notebook = new Notebook(opts.onNotebookChange);
    this.notebook.restore(opts.notebook);
    this.model = opts.model;
    this.variant = opts.agent ?? DEFAULT_VARIANT;

    const sessionTools = {
      ...this.notebook.tools(),
      ...(opts.memory ? opts.memory.tools() : {}),
      ...(opts.skills && opts.skills.length > 0 ? { skill: createSkillTool(opts.skills) } : {}),
      ...(opts.ask ? { ask: createAskTool(opts.ask) } : {}),
    };
    this.tools = { ...builtinTools, ...sessionTools, ...(opts.plugins?.tools ?? {}), ...(opts.extraTools ?? {}) };

    this.permissions = new Permissions({
      ...(opts.permissions ? { config: opts.permissions } : {}),
      ...(opts.yolo ? { yolo: true } : {}),
      autoApprove: [
        ...(opts.autoApprove ?? []),
        ...(opts.plugins?.autoApprove ?? []),
        // A session tool touches the agent's own state, not the workspace.
        ...Object.keys(sessionTools),
      ],
    });
  }

  /**
   * The approval channel a `worker` subagent uses for its gated calls.
   *
   * Same rules, same prompt, same grants as a direct call: a subagent that could
   * approve its own writes would be a way to launder a tool call past the user.
   * Handed to `createTaskTool` from cli.tsx, which is where the two are wired.
   */
  approveForSubagent(): (req: { toolName: string; input: unknown }) => Promise<boolean> {
    return async ({ toolName, input }) => {
      const blocked = await this.opts.plugins?.guard({
        toolName,
        input,
        cwd: this.opts.cwd ?? process.cwd(),
      });
      if (blocked) return false;

      const { decision, pattern } = this.permissions.check(toolName, input);
      if (decision === 'deny') return false;
      if (decision === 'allow') return true;

      const answer = await this.opts.askApproval({
        approvalId: `sub:${toolName}`,
        toolName,
        input,
        ...(pattern ? { matchedPattern: pattern } : {}),
        suggestedPattern: this.permissions.suggest(toolName, input),
        subagent: true,
      });
      if (answer === 'always') this.permissions.grant(toolName, this.permissions.suggest(toolName, input));
      return answer !== 'deny';
    };
  }

  setModel(model: LanguageModel): void {
    this.model = model;
  }

  setAgent(variant: AgentVariant): void {
    this.variant = variant;
  }

  agent(): AgentVariant {
    return this.variant;
  }

  /**
   * Tool names offered this turn. A read-only variant hides the mutating tools;
   * a disabled tool set is withheld from the wire and from the prompt, since a
   * prompt that names an absent tool teaches calls that cannot succeed.
   */
  activeTools(): string[] {
    const withheld = new Set(disabledToolNames(this.opts.toolSets));
    const all = Object.keys(this.tools).filter((name) => !withheld.has(name));
    if (!this.variant.allowTools) return all;
    return all.filter((name) => this.variant.allowTools!.includes(name));
  }

  reset(): void {
    this.messages.length = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.notebook.clear();
    this.opts.onChange?.(this.messages);
  }

  replace(messages: ModelMessage[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
    this.opts.onChange?.(this.messages);
  }

  abort(): void {
    this.controller?.abort();
  }

  estimatedTokens(): number {
    return estimateTokens(this.messages);
  }

  /** Where compaction kicks in, so the status bar can show how close it is. */
  compactThreshold(): number {
    return this.opts.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  }

  private systemFor(): string {
    return systemPrompt({
      cwd: this.opts.cwd ?? process.cwd(),
      instructions: this.opts.instructions ?? [],
      notebook: this.notebook.render(),
      memory: this.opts.memory?.render() ?? '',
      skills: renderSkills(this.opts.skills ?? []),
      agent: renderAgent(this.variant),
      plugins: this.opts.plugins?.appendix ?? '',
      availableTools: this.activeTools(),
      canAsk: this.opts.ask !== undefined && this.activeTools().includes('ask'),
    });
  }

  /**
   * How many times this exact call has already been made this turn.
   *
   * A model that repeats an identical call is not making progress: either it is
   * ignoring the result or the result is not what it needed. Three is the point
   * where that stops looking like a coincidence.
   */
  private repeatCount(toolName: string, input: unknown): number {
    const key = callKey(toolName, input);
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    return count;
  }

  /**
   * Approval decisions, evaluated per call by the SDK.
   *
   * Order matters, and each step exists for a different reason:
   *
   * 1. A plugin guard refuses outright. `--yolo` cannot reach it, because a
   *    refusal is a policy decision rather than a permission question.
   * 2. Permission rules decide allow / ask / deny, matched against the call's
   *    subject — the command, the path — not just the tool name.
   * 3. An allowed call that has now repeated three times identically is asked
   *    about anyway. A rule saying `bash: allow` is a statement about which
   *    commands are safe, not permission to run one in a loop forever.
   *
   * `why` collects what the UI needs to explain the prompt, keyed by call, because
   * the SDK's own approval request carries only the tool name and input.
   */
  private toolApproval(notices: string[], why: Map<string, ApprovalContext>) {
    return async ({ toolCall }: { toolCall: { toolName: string; input: unknown } }) => {
      const { toolName, input } = toolCall;

      const blocked = await this.opts.plugins?.guard({
        toolName,
        input,
        cwd: this.opts.cwd ?? process.cwd(),
      });
      if (blocked) {
        notices.push(blocked);
        return { type: 'denied' as const, reason: blocked };
      }

      const { decision, pattern } = this.permissions.check(toolName, input);
      if (decision === 'deny') {
        const reason = pattern
          ? `Refused by the permission rule ${toolName}: "${pattern}" = deny.`
          : `Refused by the permission rules: ${toolName} is denied.`;
        notices.push(reason);
        return { type: 'denied' as const, reason };
      }

      const repeats = this.repeatCount(toolName, input);
      if (decision === 'allow' && repeats < REPEAT_LIMIT) return undefined;

      why.set(callKey(toolName, input), {
        ...(pattern ? { matchedPattern: pattern } : {}),
        suggestedPattern: this.permissions.suggest(toolName, input),
        ...(decision === 'allow' ? { repeated: true } : {}),
      });
      return 'user-approval' as const;
    };
  }

  /** Replaces the history with a model-written summary. Backs the /compact command. */
  async summarize(): Promise<{ before: number; after: number }> {
    const before = this.messages.length;
    if (before === 0) return { before, after: 0 };

    const { text } = await generateText({
      model: this.model,
      system:
        'Summarize this coding session for use as the sole context of a fresh session. ' +
        'Keep: the user goal, files touched with paths, decisions made, commands run and their outcome, ' +
        'and what remains to be done. Drop pleasantries and full file contents. Write it as notes, not prose.',
      messages: this.messages,
      maxRetries: this.opts.maxRetries ?? 3,
    });

    this.messages.length = 0;
    this.messages.push({ role: 'user', content: `Summary of the session so far:\n\n${text}` });
    this.opts.onChange?.(this.messages);
    return { before, after: this.messages.length };
  }

  async *send(userText: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: userText });
    this.opts.onChange?.(this.messages);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const threshold = this.compactThreshold();
    // Per turn, not per step: a tool called once in each of three steps is the
    // loop this guards against.
    this.seen.clear();
    this.staleItemsRepaired = false;

    const outputs: Extract<AgentEvent, { type: 'tool-output' }>[] = [];
    onBashOutput(({ toolCallId, chunk }) => {
      outputs.push({ type: 'tool-output', id: toolCallId, chunk });
      this.opts.onToolOutput?.(toolCallId, chunk);
    });

    try {
      yield* this.run(signal, threshold, outputs);
    } finally {
      onBashOutput(undefined);
      await this.opts.plugins?.afterTurn();
    }
  }

  /**
   * Rewrites the history so nothing points at provider-side storage, once per turn.
   *
   * The 404 repeats for every reference in the request, and a repair that could run
   * twice would retry a request that cannot be made to work.
   */
  private repairStaleItems(): boolean {
    if (this.staleItemsRepaired) return false;
    this.staleItemsRepaired = true;
    this.replace(detachProviderItems(this.messages));
    return true;
  }

  private async *run(
    signal: AbortSignal,
    threshold: number,
    outputs: Extract<AgentEvent, { type: 'tool-output' }>[],
  ): AsyncGenerator<AgentEvent> {
    // Each iteration is one model run. A run ends either finished, or suspended
    // on tool approvals, in which case we collect decisions and run again.
    let compactionReported = false;
    while (true) {
      const pending: ApprovalRequest[] = [];
      const compactions: Extract<AgentEvent, { type: 'compacted' }>[] = [];
      const guardNotices: string[] = [];
      const why = new Map<string, ApprovalContext>();
      let sawError = false;
      let delivered = false;
      let staleRetry = false;

      const result = streamText({
        model: this.model,
        system: this.systemFor(),
        messages: this.messages,
        tools: this.tools,
        activeTools: this.activeTools(),
        reasoning: sdkReasoning(this.variant.thinking),
        toolApproval: this.toolApproval(guardNotices, why),
        stopWhen: isStepCount(this.variant.maxSteps ?? this.opts.maxSteps ?? 50),
        maxRetries: this.opts.maxRetries ?? 3,
        abortSignal: signal,
        prepareStep: ({ messages }) => {
          // Rebuilt every step: a todo_write earlier in this same run must be
          // visible to the steps that follow it, not only to the next turn.
          const instructions = this.systemFor();
          if (estimateTokens(messages) <= threshold) return { instructions };
          const pruned = pruneToFit({ messages, threshold, estimate: estimateTokens });
          // prepareStep cannot yield, so queue the notice and drain it in the loop.
          if (!compactionReported) {
            compactions.push({ type: 'compacted', before: messages.length, after: pruned.length });
            compactionReported = true;
          }
          return { instructions, messages: pruned };
        },
      });

      // Every promise-shaped accessor settles independently of the stream. Any one
      // left without a rejection sink surfaces as an unhandled rejection on abort
      // or API failure, which scribbles over the Ink render.
      const sink = () => {};
      void result.responseMessages.then(undefined, sink);
      void result.usage.then(undefined, sink);
      void result.steps.then(undefined, sink);
      void result.finalStep.then(undefined, sink);
      void result.text.then(undefined, sink);
      void result.finishReason.then(undefined, sink);

      try {
        for await (const part of result.stream) {
          while (compactions.length > 0) yield compactions.shift()!;
          while (outputs.length > 0) yield outputs.shift()!;
          while (guardNotices.length > 0) yield { type: 'notice', text: guardNotices.shift()! };
          switch (part.type) {
            case 'text-delta':
              delivered = true;
              yield { type: 'text', text: part.text };
              break;
            case 'reasoning-delta':
              delivered = true;
              yield { type: 'reasoning', text: part.text };
              break;
            case 'tool-input-start':
              // Arrives before the arguments finish streaming, so the UI can name
              // the tool while the model is still writing its input.
              delivered = true;
              yield { type: 'tool-start', id: part.id, name: part.toolName };
              break;
            case 'tool-call':
              yield { type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input };
              break;
            case 'tool-result':
              yield { type: 'tool-result', id: part.toolCallId, name: part.toolName, output: part.output };
              break;
            case 'tool-error':
              yield { type: 'tool-error', id: part.toolCallId, name: part.toolName, error: part.error };
              break;
            case 'tool-approval-request': {
              // A guard denial is answered by the SDK itself and arrives flagged
              // automatic; queueing it would prompt the user for a settled call.
              if (part.isAutomatic) break;
              const context = why.get(callKey(part.toolCall.toolName, part.toolCall.input));
              pending.push({
                approvalId: part.approvalId,
                toolName: part.toolCall.toolName,
                input: part.toolCall.input,
                suggestedPattern: '*',
                ...context,
              });
              break;
            }
            case 'tool-approval-response':
              if (!part.approved) yield { type: 'tool-denied', name: part.toolCall.toolName };
              break;
            case 'tool-output-denied':
              yield { type: 'tool-denied', name: part.toolName };
              break;
            case 'abort':
              yield { type: 'done' };
              return;
            case 'error':
              // A stale item is rejected before generation starts, so nothing has
              // been said yet and the request can be rebuilt. Once output is on
              // screen it cannot be unsent, and a retry would repeat it.
              if (!delivered && isStaleItemError(part.error) && this.repairStaleItems()) {
                yield { type: 'notice', text: STALE_ITEM_NOTICE };
                staleRetry = true;
                break;
              }
              sawError = true;
              yield { type: 'error', error: part.error };
              break;
            default:
              break;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          yield { type: 'done' };
          return;
        }
        if (!delivered && isStaleItemError(error) && this.repairStaleItems()) {
          yield { type: 'notice', text: STALE_ITEM_NOTICE };
          continue;
        }
        yield { type: 'error', error };
        return;
      }

      // The history was rewritten under this run, so its promise-shaped results
      // describe a request that no longer stands. Run again rather than read them.
      if (staleRetry) continue;

      // A stream that ended in an error has no response messages or usage to
      // await; touching them would throw NoOutputGeneratedError.
      if (sawError) return;

      while (compactions.length > 0) yield compactions.shift()!;
      while (outputs.length > 0) yield outputs.shift()!;
      while (guardNotices.length > 0) yield { type: 'notice', text: guardNotices.shift()! };

      this.messages.push(...(await result.responseMessages));
      this.opts.onChange?.(this.messages);

      if (pending.length === 0) {
        const usage = await result.usage;
        this.inputTokens += usage.inputTokens ?? 0;
        this.outputTokens += usage.outputTokens ?? 0;
        yield { type: 'done', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        return;
      }

      const responses: ToolApprovalResponse[] = [];
      for (const req of pending) {
        const decision = await this.opts.askApproval(req);
        // `always` records the pattern the tool suggested, so approving
        // `git status` whitelists `git *` rather than every command.
        if (decision === 'always') this.permissions.grant(req.toolName, req.suggestedPattern);
        responses.push({
          type: 'tool-approval-response',
          approvalId: req.approvalId,
          approved: decision !== 'deny',
          ...(decision === 'deny' ? { reason: 'User denied this tool call.' } : {}),
        });
      }
      this.messages.push({ role: 'tool', content: responses });
    }
  }
}
