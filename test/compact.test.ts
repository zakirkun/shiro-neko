import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError, type ModelMessage } from 'ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, type AgentEvent } from '../src/session';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5 },
} as any;

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }),
});

const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

/** One assistant turn carrying a bulky tool call plus its result. */
function bulkyExchange(i: number): ModelMessage[] {
  return [
    { role: 'user', content: `question ${i}` },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `t${i}`, toolName: 'read_file', input: { path: `f${i}.ts` } }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `t${i}`,
          toolName: 'read_file',
          output: { type: 'text', value: 'x'.repeat(5000) },
        },
      ],
    },
  ];
}

test('history under the threshold is sent untouched', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        return stream(text('ok'));
      },
    }),
    askApproval: async () => 'deny',
    messages: [...bulkyExchange(0)],
    compactThreshold: 1_000_000,
  });

  for await (const _ of session.send('next')) void _;

  expect(JSON.stringify(seen[0]?.prompt)).toContain('x'.repeat(5000));
});

test('history over the threshold is pruned before reaching the model', async () => {
  const messages = [...bulkyExchange(0), ...bulkyExchange(1), ...bulkyExchange(2), ...bulkyExchange(3)];
  const seen: LanguageModelV4CallOptions[] = [];
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        return stream(text('ok'));
      },
    }),
    askApproval: async () => 'deny',
    messages: [...messages],
    compactThreshold: 1000,
  });

  const beforeTokens = session.estimatedTokens();
  expect(beforeTokens).toBeGreaterThan(1000);

  const events: string[] = [];
  for await (const ev of session.send('next')) events.push(ev.type);

  const sentSize = JSON.stringify(seen[0]?.prompt).length;
  expect(sentSize).toBeLessThan(JSON.stringify(messages).length);

  // Pruning is for the wire only; the local history keeps every message.
  expect(session.messages.length).toBeGreaterThan(messages.length);
  expect(events).toContain('compacted');
});

test('the compacted event reports the counts and arrives before done', async () => {
  const messages = [...bulkyExchange(0), ...bulkyExchange(1), ...bulkyExchange(2), ...bulkyExchange(3)];
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
    messages: [...messages],
    compactThreshold: 1000,
  });

  const events: AgentEvent[] = [];
  for await (const ev of session.send('next')) events.push(ev);

  const compacted = events.find((e) => e.type === 'compacted');
  if (compacted?.type !== 'compacted') throw new Error('expected a compacted event');
  expect(compacted.before).toBeGreaterThan(compacted.after);
  expect(compacted.after).toBeGreaterThan(0);

  expect(events.findIndex((e) => e.type === 'compacted')).toBeLessThan(
    events.findIndex((e) => e.type === 'done'),
  );
});

test('history under the threshold emits no compacted event', async () => {
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
    messages: [...bulkyExchange(0)],
    compactThreshold: 1_000_000,
  });

  const events: string[] = [];
  for await (const ev of session.send('next')) events.push(ev.type);
  expect(events).not.toContain('compacted');
});

test('summarize replaces the whole history with one summary message', async () => {
  let generateCalls = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doGenerate: async () => {
        generateCalls++;
        return {
          content: [{ type: 'text', text: '- goal: add pagination\n- touched: src/users.ts\n- todo: add tests' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        } as any;
      },
    }),
    askApproval: async () => 'deny',
    messages: [...bulkyExchange(0), ...bulkyExchange(1)],
  });

  const { before, after } = await session.summarize();

  expect(generateCalls).toBe(1);
  expect(before).toBe(6);
  expect(after).toBe(1);
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0]?.role).toBe('user');
  expect(String(session.messages[0]?.content)).toContain('add pagination');
});

test('summarize on an empty session is a no-op', async () => {
  const session = new Session({
    model: new MockLanguageModelV4({ doGenerate: async () => ({}) as any }),
    askApproval: async () => 'deny',
  });
  expect(await session.summarize()).toEqual({ before: 0, after: 0 });
});

test('onChange fires for every history mutation so autosave stays current', async () => {
  const snapshots: number[] = [];
  const session = new Session({
    model: new MockLanguageModelV4({ doStream: async () => stream(text('ok')) }),
    askApproval: async () => 'deny',
    onChange: (m) => snapshots.push(m.length),
  });

  for await (const _ of session.send('hello')) void _;

  expect(snapshots).toEqual([1, 2]);
});

/** A reasoning model's turn: a reasoning item, then the tool call, both with item ids. */
const reasoningToolStep = (n: number): LanguageModelV4StreamPart[] => [
  { type: 'reasoning-start', id: `r${n}`, providerMetadata: { openai: { itemId: `rs_${n}` } } } as never,
  { type: 'reasoning-delta', id: `r${n}`, delta: 'deciding what to read next' } as never,
  { type: 'reasoning-end', id: `r${n}`, providerMetadata: { openai: { itemId: `rs_${n}` } } } as never,
  { type: 'tool-input-start', id: `c${n}`, toolName: 'read_file' },
  { type: 'tool-input-end', id: `c${n}` },
  {
    type: 'tool-call',
    toolCallId: `c${n}`,
    toolName: 'read_file',
    input: JSON.stringify({ path: 'big.txt' }),
    providerMetadata: { openai: { itemId: `fc_${n}` } },
  } as never,
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];

function inTempDir<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-compact-'));
  process.chdir(dir);
  return fn().finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * The bug this guards against: compaction used to drop any assistant part whose
 * reasoning item it had pruned. On a reasoning model that is every tool call, so
 * after the first compaction the model could no longer see what it had already
 * run — and kept re-running it until the step limit stopped the turn.
 */
test('a compacted turn still shows the model the tool calls it already made', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'big.txt'), 'lorem ipsum dolor sit amet\n'.repeat(1500));

    const seen: LanguageModelV4CallOptions[] = [];
    let call = 0;
    const session = new Session({
      compactThreshold: 4000,
      maxSteps: 8,
      model: new MockLanguageModelV4({
        doStream: async (o) => {
          seen.push(o);
          const n = call++;
          return n < 3 ? stream(reasoningToolStep(n)) : stream(text('read it three times'));
        },
      }),
      askApproval: async () => 'deny',
    });

    const events: string[] = [];
    for await (const ev of session.send('read big.txt a few times')) events.push(ev.type);

    expect(events).toContain('compacted');
    expect(events).toContain('text');
    expect(events.at(-1)).toBe('done');
    // Four calls, not eight: the loop ended because the model chose to, not
    // because maxSteps cut it off.
    expect(call).toBe(4);

    const shapeOf = (o: LanguageModelV4CallOptions) =>
      o.prompt
        .filter((m) => m.role !== 'system')
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string }[]).map((p) => p.type) : ['str']));

    // Every call after the first has to carry the earlier exchange.
    for (const o of seen.slice(1)) {
      const shape = shapeOf(o);
      expect(shape).toContain('tool-call');
      expect(shape).toContain('tool-result');
    }
  }), 20_000);

test('a multi-step turn emits one compacted event', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'big.txt'), 'lorem ipsum dolor sit amet\n'.repeat(1500));

    let call = 0;
    const session = new Session({
      compactThreshold: 4000,
      maxSteps: 8,
      model: new MockLanguageModelV4({
        doStream: async () => {
          const n = call++;
          return n < 3 ? stream(reasoningToolStep(n)) : stream(text('done'));
        },
      }),
      askApproval: async () => 'deny',
    });

    const events: AgentEvent[] = [];
    for await (const ev of session.send('read big.txt a few times')) events.push(ev);

    expect(events.filter((ev) => ev.type === 'compacted')).toHaveLength(1);
    expect(call).toBe(4);
  }), 20_000);

test('a compacted turn sends no assistant item reference whose reasoning was pruned', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'big.txt'), 'lorem ipsum dolor sit amet\n'.repeat(1500));

    const seen: LanguageModelV4CallOptions[] = [];
    let call = 0;
    const session = new Session({
      compactThreshold: 4000,
      model: new MockLanguageModelV4({
        doStream: async (o) => {
          seen.push(o);
          const n = call++;
          return n < 3 ? stream(reasoningToolStep(n)) : stream(text('done'));
        },
      }),
      askApproval: async () => 'deny',
    });

    for await (const _ of session.send('read it')) void _;

    // An itemId on an assistant part is serialised as `item_reference`, which the
    // responses API resolves against a stored item that depends on its reasoning
    // item. Send one without that reasoning and the request is a 400. An itemId on
    // a tool result is harmless: it goes out as a plain function_call_output.
    for (const [i, o] of seen.entries()) {
      const assistant = o.prompt.filter((m) => m.role === 'assistant');
      const reasoningIds = new Set<string>();
      for (const m of assistant) {
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content as { type: string; providerOptions?: Record<string, Record<string, unknown>> }[]) {
          if (p.type !== 'reasoning') continue;
          for (const options of Object.values(p.providerOptions ?? {})) {
            if (typeof options['itemId'] === 'string') reasoningIds.add(options['itemId']);
          }
        }
      }

      for (const m of assistant) {
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content as { type: string; providerOptions?: Record<string, Record<string, unknown>> }[]) {
          if (p.type === 'reasoning') continue;
          for (const options of Object.values(p.providerOptions ?? {})) {
            const id = options['itemId'];
            if (typeof id !== 'string') continue;
            expect(reasoningIds.size, `call ${i}: ${p.type} references ${id} with no reasoning item`).toBeGreaterThan(0);
          }
        }
      }
    }
  }), 20_000);

test('a compacted turn inlines a plain assistant item instead of referencing remote storage', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const session = new Session({
    messages: [
      { role: 'user', content: `earlier question ${'x'.repeat(4000)}` },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'remembered answer', providerOptions: { openai: { itemId: 'msg_stale' } } }],
      },
    ],
    compactThreshold: 100,
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        return stream(text('ok'));
      },
    }),
    askApproval: async () => 'deny',
  });

  const events: AgentEvent[] = [];
  for await (const event of session.send('continue')) events.push(event);

  expect(events.some((event) => event.type === 'compacted')).toBe(true);
  expect(JSON.stringify(seen[0]?.prompt)).not.toContain('msg_stale');
  expect(JSON.stringify(seen[0]?.prompt)).toContain('remembered answer');
});

/**
 * The failure this guards against: an item reference the provider no longer holds is
 * rejected with 404 "Item with id 'msg_...' not found", and every retry of the same
 * history is rejected the same way, so resuming a session could never get going.
 */
const staleItem = (id: string) =>
  new APICallError({
    message: `Item with id '${id}' not found.`,
    url: 'https://api.openai.com/v1/responses',
    requestBodyValues: {},
    statusCode: 404,
    isRetryable: false,
  });

const withStoredItem = (): ModelMessage[] => [
  { role: 'user', content: 'earlier question' },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'remembered answer', providerOptions: { openai: { itemId: 'msg_gone' } } }],
  },
];

test('a rejected stale item reference is retried inline rather than ending the turn', async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  let call = 0;
  const session = new Session({
    messages: withStoredItem(),
    model: new MockLanguageModelV4({
      doStream: async (o) => {
        seen.push(o);
        if (call++ === 0) throw staleItem('msg_gone');
        return stream(text('picked up where we left off'));
      },
    }),
    askApproval: async () => 'deny',
    maxRetries: 0,
  });

  const events: AgentEvent[] = [];
  for await (const event of session.send('continue')) events.push(event);

  expect(events.map((e) => e.type)).toEqual(['notice', 'text', 'done']);
  expect(call).toBe(2);
  expect(JSON.stringify(seen[0]?.prompt)).toContain('msg_gone');
  // The retry carries the same content with nothing pointing at provider storage.
  expect(JSON.stringify(seen[1]?.prompt)).not.toContain('msg_gone');
  expect(JSON.stringify(seen[1]?.prompt)).toContain('remembered answer');
  // Repaired in place, so a save or a later turn cannot resend the dead reference.
  expect(JSON.stringify(session.messages)).not.toContain('msg_gone');
});

test('a stale item rejection that survives the repair is reported once, not looped', async () => {
  let call = 0;
  const session = new Session({
    messages: withStoredItem(),
    model: new MockLanguageModelV4({
      doStream: async () => {
        call++;
        throw staleItem('msg_gone');
      },
    }),
    askApproval: async () => 'deny',
    maxRetries: 0,
  });

  const events: AgentEvent[] = [];
  for await (const event of session.send('continue')) events.push(event);

  expect(events.map((e) => e.type)).toEqual(['notice', 'error']);
  expect(call).toBe(2);
});

test('a stale item arriving after text was streamed is reported, not silently repeated', async () => {
  let call = 0;
  const session = new Session({
    messages: withStoredItem(),
    model: new MockLanguageModelV4({
      doStream: async () => {
        call++;
        return stream([
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'half an answer' },
          { type: 'error', error: staleItem('msg_gone') },
        ]);
      },
    }),
    askApproval: async () => 'deny',
    maxRetries: 0,
  });

  const events: AgentEvent[] = [];
  for await (const event of session.send('continue')) events.push(event);

  // Retrying here would deliver "half an answer" twice.
  expect(events.map((e) => e.type)).toEqual(['text', 'error']);
  expect(call).toBe(1);
});

