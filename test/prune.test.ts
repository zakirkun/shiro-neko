import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { detachOrphanedItems, dropOrphanedResults, pruneToFit, prunePreservingItems } from '../src/prune';

const kinds = (messages: ModelMessage[]) =>
  messages.map((m) => (Array.isArray(m.content) ? `${m.role}:${m.content.map((p) => p.type).join('+')}` : m.role));

/** Every provider itemId in a message tree, which is what the repair strips. */
const itemIds = (messages: ModelMessage[]): string[] => {
  const found: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { providerOptions?: Record<string, Record<string, unknown>> }[]) {
      for (const options of Object.values(p.providerOptions ?? {})) {
        if (typeof options['itemId'] === 'string') found.push(options['itemId']);
      }
    }
  }
  return found;
};

/** An assistant turn as the OpenAI responses API returns it. */
const reasoningTurn = (rs: string, msg: string, text = 'answer'): ModelMessage => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'thinking', providerOptions: { openai: { itemId: rs } } },
    { type: 'text', text, providerOptions: { openai: { itemId: msg } } },
  ],
});

const toolTurn = (rs: string, call: string): ModelMessage => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'deciding', providerOptions: { openai: { itemId: rs } } },
    {
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'grep',
      input: { pattern: 'x' },
      providerOptions: { openai: { itemId: call } },
    },
  ],
});

/**
 * A part carrying an itemId is serialised as `{ type: 'item_reference', id }`,
 * which depends on the stored reasoning item. Stripping the id sends the same
 * content inline instead, so the turn survives without the dependency.
 */
test('a message left without its reasoning item keeps its text and loses its item id', () => {
  const before = [{ role: 'user' as const, content: 'q' }, reasoningTurn('rs_1', 'msg_1')];
  const after: ModelMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer', providerOptions: { openai: { itemId: 'msg_1' } } }] },
  ];

  const cleaned = detachOrphanedItems(before, after);
  expect(itemIds(cleaned)).toEqual([]);
  expect(kinds(cleaned)).toEqual(['user', 'assistant:text']);
  expect(JSON.stringify(cleaned)).toContain('answer');
});

test('a tool call left without its reasoning item survives, detached', () => {
  const before = [{ role: 'user' as const, content: 'q' }, toolTurn('rs_1', 'fc_1')];
  const after: ModelMessage[] = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc1',
          toolName: 'grep',
          input: { pattern: 'x' },
          providerOptions: { openai: { itemId: 'fc_1' } },
        },
      ],
    },
  ];

  const cleaned = detachOrphanedItems(before, after);
  expect(itemIds(cleaned)).toEqual([]);
  // The call itself has to stay, or its result is orphaned and the model loses
  // any record of what it already ran.
  expect(JSON.stringify(cleaned)).toContain('tc1');
  expect(kinds(cleaned)).toEqual(['user', 'assistant:tool-call']);
});

test('an empty providerOptions object is removed rather than left behind', () => {
  const before = [toolTurn('rs_1', 'fc_1')];
  const after: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc1',
          toolName: 'grep',
          input: { pattern: 'x' },
          providerOptions: { openai: { itemId: 'fc_1' } },
        },
      ],
    },
  ];

  const part = (detachOrphanedItems(before, after)[0]!.content as Record<string, unknown>[])[0]!;
  expect('providerOptions' in part).toBe(false);
});

test('other provider options are kept when the item id is stripped', () => {
  const before: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 't', providerOptions: { openai: { itemId: 'rs_1' } } },
        { type: 'text', text: 'a', providerOptions: { openai: { itemId: 'msg_1', phase: 'final' } } },
      ],
    },
  ];
  const after: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'a', providerOptions: { openai: { itemId: 'msg_1', phase: 'final' } } }],
    },
  ];

  const json = JSON.stringify(detachOrphanedItems(before, after));
  expect(json).not.toContain('msg_1');
  expect(json).toContain('final');
});

test('a turn whose reasoning survived is left alone', () => {
  const messages = [{ role: 'user' as const, content: 'q' }, reasoningTurn('rs_1', 'msg_1')];
  expect(detachOrphanedItems(messages, messages)).toEqual(messages);
});

test('nothing is touched when no reasoning was removed', () => {
  const before: ModelMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'plain answer' },
  ];
  expect(detachOrphanedItems(before, before)).toEqual(before);
});

test('parts with no provider itemId are returned unchanged', () => {
  const before = [reasoningTurn('rs_1', 'msg_1')];
  const after: ModelMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: 'no item id here' }] }];
  expect(detachOrphanedItems(before, after)).toEqual(after);
});

test('user and tool messages are never affected', () => {
  const before = [{ role: 'user' as const, content: 'q' }, reasoningTurn('rs_1', 'msg_1')];
  const after: ModelMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'grep', output: { type: 'text', value: 'hit' } }] },
  ];
  expect(detachOrphanedItems(before, after)).toEqual(after);
});

test('one orphaned turn does not detach a healthy one with it', () => {
  const before = [
    { role: 'user' as const, content: 'q1' },
    reasoningTurn('rs_1', 'msg_1', 'old answer'),
    { role: 'user' as const, content: 'q2' },
    reasoningTurn('rs_2', 'msg_2', 'new answer'),
  ];
  const after: ModelMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [{ type: 'text', text: 'old answer', providerOptions: { openai: { itemId: 'msg_1' } } }] },
    { role: 'user', content: 'q2' },
    reasoningTurn('rs_2', 'msg_2', 'new answer'),
  ];

  const cleaned = detachOrphanedItems(before, after);
  const json = JSON.stringify(cleaned);
  expect(json).not.toContain('msg_1');
  expect(json).toContain('old answer');
  expect(json).toContain('msg_2');
  expect(json).toContain('rs_2');
});

test('prunePreservingItems leaves no item reference behind on a real prune', () => {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'user', content: `question ${i} ${'x'.repeat(3000)}` });
    messages.push(reasoningTurn(`rs_${i}`, `msg_${i}`, `answer ${i}`));
  }

  const pruned = prunePreservingItems({
    messages,
    reasoning: 'all',
    toolCalls: 'before-last-3-messages',
    emptyMessages: 'remove',
  });

  // reasoning: 'all' removes every reasoning item, so no surviving part may still
  // reference one. The text itself stays: that is the model's memory of the turn.
  expect(itemIds(pruned)).toEqual([]);
  expect(pruned.filter((m) => m.role === 'user')).toHaveLength(6);
  expect(JSON.stringify(pruned)).toContain('answer 5');
});

test('prunePreservingItems is a no-op when nothing needs pruning', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'small' },
    { role: 'assistant', content: 'reply' },
  ];
  expect(prunePreservingItems({ messages, reasoning: 'none', emptyMessages: 'keep' })).toEqual(messages);
});

test('a provider other than openai is handled the same way', () => {
  const before: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 't', providerOptions: { someProvider: { itemId: 'r1' } } },
        { type: 'text', text: 'a', providerOptions: { someProvider: { itemId: 'm1' } } },
      ],
    },
  ];
  const after: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'text', text: 'a', providerOptions: { someProvider: { itemId: 'm1' } } }] },
  ];

  const cleaned = detachOrphanedItems(before, after);
  expect(itemIds(cleaned)).toEqual([]);
  expect(JSON.stringify(cleaned)).toContain('"text":"a"');
});

/** The assistant tool-call plus the tool message answering it, as one exchange. */
const callAndResult = (call: string, rs?: string): ModelMessage[] => [
  {
    role: 'assistant',
    content: [
      ...(rs ? [{ type: 'reasoning' as const, text: 'deciding', providerOptions: { openai: { itemId: rs } } }] : []),
      { type: 'tool-call', toolCallId: call, toolName: 'grep', input: { pattern: 'x' } },
    ],
  },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: call, toolName: 'grep', output: { type: 'text', value: 'hit' } }],
  },
];

test('a tool result left without its tool call is dropped', () => {
  const [, resultMessage] = callAndResult('call_A');
  const cleaned = dropOrphanedResults([{ role: 'user', content: 'q' }, resultMessage!]);
  expect(JSON.stringify(cleaned)).not.toContain('call_A');
  expect(kinds(cleaned)).toEqual(['user']);
});

test('a tool result keeps its place while the call is still there', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'q' }, ...callAndResult('call_A')];
  expect(dropOrphanedResults(messages)).toEqual(messages);
});

test('a tool call awaiting its result survives, since that is a suspended approval', () => {
  const [callMessage] = callAndResult('call_A');
  const messages: ModelMessage[] = [{ role: 'user', content: 'q' }, callMessage!];
  expect(dropOrphanedResults(messages)).toEqual(messages);
});

test('a tool-error is treated as a result and dropped with its call', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'q' },
    {
      role: 'tool',
      content: [{ type: 'tool-error', toolCallId: 'call_A', toolName: 'grep', error: 'boom' } as never],
    },
  ];
  expect(JSON.stringify(dropOrphanedResults(messages))).not.toContain('call_A');
});

test('only the orphaned result is dropped, not a healthy one beside it', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'q' },
    ...callAndResult('call_LIVE'),
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call_LIVE', toolName: 'grep', output: { type: 'text', value: 'a' } },
        { type: 'tool-result', toolCallId: 'call_GONE', toolName: 'grep', output: { type: 'text', value: 'b' } },
      ],
    },
  ];

  const json = JSON.stringify(dropOrphanedResults(messages));
  expect(json).toContain('call_LIVE');
  expect(json).not.toContain('call_GONE');
});

/**
 * The 400 this guards against: "No tool call found for function call output with
 * call_id ...". Pruning counts messages, so its cut lands between the assistant
 * tool-call and the tool message answering it, stranding the result on the wire.
 */
test('prunePreservingItems never strands a tool result on the wire', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: `q ${'x'.repeat(4000)}` }];
  for (let i = 0; i < 5; i++) {
    messages.push(...callAndResult(`call_${i}`, `rs_${i}`));
    messages.push({ role: 'user', content: `follow up ${i} ${'y'.repeat(4000)}` });
  }

  const pruned = prunePreservingItems({
    messages,
    reasoning: 'all',
    toolCalls: 'before-last-3-messages',
    emptyMessages: 'remove',
  });

  const calls = new Set<string>();
  for (const m of pruned) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string; toolCallId?: string }[]) {
      if (p.type === 'tool-call' && p.toolCallId) calls.add(p.toolCallId);
    }
  }
  for (const m of pruned) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string; toolCallId?: string }[]) {
      if (p.type === 'tool-result' || p.type === 'tool-error') expect(calls.has(p.toolCallId!)).toBe(true);
    }
  }
});

const estimate = (messages: ModelMessage[]) => Math.round(JSON.stringify(messages).length / 4);

/** `size` chars of tool output per step, so a transcript's weight is controllable. */
function transcript(steps: number, size: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'do the thing' }];
  for (let i = 0; i < steps; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'deciding', providerOptions: { openai: { itemId: `rs_${i}` } } },
        { type: 'tool-call', toolCallId: `t${i}`, toolName: 'read_file', input: { path: `f${i}.ts` } },
      ],
    });
    messages.push({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: `t${i}`, toolName: 'read_file', output: { type: 'text', value: 'x'.repeat(size) } },
      ],
    });
  }
  return messages;
}

const toolCallsIn = (messages: ModelMessage[]): number => {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string }[]) if (p.type === 'tool-call') n++;
  }
  return n;
};

/**
 * The loop this guards against: a fixed `before-last-3-messages` strips tool parts
 * from every earlier message, `emptyMessages: 'remove'` then deletes the emptied
 * messages, and a long agent transcript collapses to a handful. The model loses its
 * record of what it ran and runs it again, which on screen is `git_status` and
 * `list_dir` repeating with a compaction notice between them.
 */
test('a long transcript keeps most of its tool calls when reasoning alone is enough', () => {
  const messages = transcript(200, 100);
  const fitted = pruneToFit({ messages, threshold: estimate(messages), estimate });

  expect(toolCallsIn(fitted)).toBe(200);
  expect(fitted.length).toBeGreaterThan(messages.length - 10);
});

test('tool content is only dropped when dropping reasoning was not enough', () => {
  const messages = transcript(200, 4000);
  // Far below the transcript's own weight, so the ladder has to descend.
  const fitted = pruneToFit({ messages, threshold: 20_000, estimate });

  expect(estimate(fitted)).toBeLessThanOrEqual(20_000);
  // The old behaviour left two. Anything in that range is the bug returning.
  expect(toolCallsIn(fitted)).toBeGreaterThan(2);
});

test('the widest rung that fits is the one used', () => {
  const messages = transcript(200, 300);
  const wide = pruneToFit({ messages, threshold: estimate(messages), estimate });
  const narrow = pruneToFit({ messages, threshold: 5_000, estimate });

  expect(toolCallsIn(wide)).toBeGreaterThan(toolCallsIn(narrow));
});

test('an impossible threshold returns the narrowest rung rather than nothing', () => {
  const messages = transcript(200, 4000);
  const fitted = pruneToFit({ messages, threshold: 10, estimate });

  expect(fitted.length).toBeGreaterThan(0);
  expect(fitted[0]?.role).toBe('user');
});

test('pruning to fit never strands a tool result, at any rung', () => {
  const messages = transcript(120, 4000);
  for (const threshold of [10, 5_000, 20_000, 100_000, estimate(messages)]) {
    const fitted = pruneToFit({ messages, threshold, estimate });
    const calls = new Set<string>();
    for (const m of fitted) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as { type: string; toolCallId?: string }[]) {
        if (p.type === 'tool-call' && p.toolCallId) calls.add(p.toolCallId);
      }
    }
    for (const m of fitted) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as { type: string; toolCallId?: string }[]) {
        if (p.type === 'tool-result') expect(calls.has(p.toolCallId!), `threshold ${threshold}`).toBe(true);
      }
    }
  }
});

test('reasoning is always dropped, whatever the threshold', () => {
  const messages = transcript(20, 100);
  const fitted = pruneToFit({ messages, threshold: estimate(messages), estimate });
  expect(itemIds(fitted)).toEqual([]);
  expect(JSON.stringify(fitted)).not.toContain('deciding');
});

test('compaction removes a plain assistant item reference without inline reasoning', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: `question ${'x'.repeat(2000)}` },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer', providerOptions: { openai: { itemId: 'msg_plain' } } }],
    },
  ];

  const fitted = pruneToFit({ messages, threshold: 1, estimate });

  expect(itemIds(fitted)).toEqual([]);
  expect(JSON.stringify(fitted)).toContain('answer');
});

test('the user prompt survives even the narrowest rung', () => {
  const messages = transcript(200, 4000);
  const fitted = pruneToFit({ messages, threshold: 100, estimate });
  expect(JSON.stringify(fitted)).toContain('do the thing');
});
