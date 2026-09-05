import { pruneMessages, type ModelMessage } from 'ai';

type Part = {
  type: string;
  toolCallId?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
};

function itemId(part: Part): string | undefined {
  for (const options of Object.values(part.providerOptions ?? {})) {
    const id = options['itemId'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

const partsOf = (message: ModelMessage): Part[] =>
  message.role === 'assistant' && Array.isArray(message.content) ? (message.content as Part[]) : [];

/** The part again, with every provider `itemId` removed. */
function withoutItemId(part: Part): Part {
  const providerOptions: Record<string, Record<string, unknown>> = {};
  for (const [provider, options] of Object.entries(part.providerOptions ?? {})) {
    const { itemId: _dropped, ...rest } = options;
    if (Object.keys(rest).length > 0) providerOptions[provider] = rest;
  }
  const next: Part = { ...part };
  if (Object.keys(providerOptions).length > 0) next.providerOptions = providerOptions;
  else delete next.providerOptions;
  return next;
}

/**
 * Detaches assistant parts from reasoning items that pruning removed.
 *
 * A part carrying a provider `itemId` is not sent inline. The OpenAI responses
 * provider serialises it as `{ type: 'item_reference', id }`, pointing at an item
 * stored on their side, and that stored item depends on the `reasoning` item from
 * the same response. Send the reference without the reasoning and the request is
 * rejected with 400 "was provided without its required 'reasoning' item".
 *
 * The repair is to drop the `itemId`, not the part. Without it the same content is
 * serialised inline — a plain assistant message, a plain `function_call` — which
 * carries no dependency on anything stored. Verified against the provider's own
 * serialiser: `text` with an itemId goes out as `item_reference`, and the identical
 * part without one goes out as `output_text`.
 *
 * Dropping the part instead, which is what this used to do, cost the model its
 * memory of the turn: after compaction it could no longer see the tool results it
 * had just collected, so it called the same tools again until it hit the step limit.
 */
export function detachOrphanedItems(before: ModelMessage[], after: ModelMessage[]): ModelMessage[] {
  const survivingReasoning = new Set<string>();
  for (const message of after) {
    for (const part of partsOf(message)) {
      if (part.type !== 'reasoning') continue;
      const id = itemId(part);
      if (id) survivingReasoning.add(id);
    }
  }

  const orphaned = new Set<string>();
  for (const message of before) {
    const parts = partsOf(message);
    const reasoning = parts.filter((p) => p.type === 'reasoning').map(itemId);
    if (reasoning.length === 0) continue;
    if (reasoning.some((id) => id !== undefined && survivingReasoning.has(id))) continue;

    for (const part of parts) {
      const id = itemId(part);
      if (id) orphaned.add(id);
    }
  }

  if (orphaned.size === 0) return after;

  return after.map((message) => {
    const parts = partsOf(message);
    if (parts.length === 0) return message;

    let changed = false;
    const next = parts.map((part) => {
      const id = itemId(part);
      if (id === undefined || !orphaned.has(id)) return part;
      changed = true;
      return withoutItemId(part);
    });

    return changed ? ({ ...message, content: next } as ModelMessage) : message;
  });
}

export type PruneOptions = Parameters<typeof pruneMessages>[0];

const ANSWER_PARTS = new Set(['tool-result', 'tool-error']);

const anyParts = (message: ModelMessage): Part[] =>
  Array.isArray(message.content) ? (message.content as Part[]) : [];

/**
 * Every part again with its provider `itemId` gone, so the history goes out inline
 * rather than as `item_reference` entries pointing at provider-side storage.
 *
 * A reference only resolves while the provider still holds that item; once it does
 * not, the request is rejected with 404 "Item with id '...' not found" and no retry
 * of the same history can succeed. The content is already in the local history, so
 * inlining loses nothing.
 */
export function detachProviderItems(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const parts = anyParts(message);
    if (parts.length === 0) return message;

    let changed = false;
    const next = parts.map((part) => {
      if (itemId(part) === undefined) return part;
      changed = true;
      return withoutItemId(part);
    });

    return changed ? ({ ...message, content: next } as ModelMessage) : message;
  });
}

/**
 * Drops tool results whose tool call is gone.
 *
 * The OpenAI responses API rejects a `function_call_output` with no `function_call`
 * carrying the same call id: 400 "No tool call found for function call output with
 * call_id ...". `pruneMessages({ toolCalls: 'before-last-3-messages' })` counts
 * messages, so the cut can land between an assistant tool-call and the tool message
 * answering it.
 *
 * The reverse pairing is left alone on purpose: a call still awaiting its result is
 * exactly what a suspended approval looks like, and dropping it would break resume.
 */
export function dropOrphanedResults(messages: ModelMessage[]): ModelMessage[] {
  const calls = new Set<string>();
  for (const message of messages) {
    for (const part of anyParts(message)) {
      if (part.type === 'tool-call' && part.toolCallId) calls.add(part.toolCallId);
    }
  }

  const cleaned: ModelMessage[] = [];
  for (const message of messages) {
    const parts = anyParts(message);
    if (parts.length === 0) {
      cleaned.push(message);
      continue;
    }

    const kept = parts.filter(
      (part) => !ANSWER_PARTS.has(part.type) || part.toolCallId === undefined || calls.has(part.toolCallId),
    );

    if (kept.length === parts.length) cleaned.push(message);
    else if (kept.length > 0) cleaned.push({ ...message, content: kept } as ModelMessage);
  }

  return cleaned;
}

/** pruneMessages, then repair the provider-item dependencies it breaks. */
export function prunePreservingItems(options: PruneOptions): ModelMessage[] {
  const pruned = pruneMessages(options);
  return dropOrphanedResults(detachOrphanedItems(options.messages, pruned));
}

/**
 * How many trailing messages keep their tool content, widest first.
 *
 * One agent step is two messages — the assistant's tool call and the tool message
 * answering it — so 64 is about 32 steps of memory.
 */
const KEEP_LADDER = [64, 32, 16, 8, 4] as const;

export type FitOptions = {
  messages: ModelMessage[];
  /** Estimated tokens the wire history must come in under. */
  threshold: number;
  estimate: (messages: ModelMessage[]) => number;
};

/**
 * Prunes only as hard as the threshold requires.
 *
 * A fixed `before-last-3-messages` is catastrophic on an agent transcript, because
 * nearly every assistant and tool message there consists of nothing but tool parts:
 * stripping them empties the message, `emptyMessages: 'remove'` deletes it, and a
 * 405-message history collapses to five. Measured on a synthetic run of 202 steps —
 * two surviving tool calls out of 202.
 *
 * That is not a cost problem, it is a correctness one. The model loses its record of
 * what it already ran, so it runs it again, the history grows, the threshold is
 * crossed again, and the turn never converges. It looks like `git_status` and
 * `list_dir` being called in a circle with a compaction notice between them.
 *
 * So: drop reasoning first, since it is never needed on the wire, and only reach for
 * tool content if that was not enough — keeping as much of the recent tail as fits.
 * The widest rung that comes in under the threshold wins; if even the narrowest does
 * not, the narrowest is returned, because sending something is better than sending a
 * request that will be rejected for size.
 */
export function pruneToFit({ messages, threshold, estimate }: FitOptions): ModelMessage[] {
  const withoutReasoning = detachProviderItems(
    prunePreservingItems({ messages, reasoning: 'all', emptyMessages: 'remove' }),
  );
  if (estimate(withoutReasoning) <= threshold) return withoutReasoning;

  let narrowest = withoutReasoning;
  for (const keep of KEEP_LADDER) {
    narrowest = detachProviderItems(
      prunePreservingItems({
        messages,
        reasoning: 'all',
        toolCalls: `before-last-${keep}-messages`,
        emptyMessages: 'remove',
      }),
    );
    if (estimate(narrowest) <= threshold) return narrowest;
  }
  return narrowest;
}

export { KEEP_LADDER };
