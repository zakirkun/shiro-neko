import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Session } from '../src/session';
import { App, createApprovalBridge, type AppHooks } from '../src/ui/App';
import { testHooks } from './helpers';

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 500 },
} as any;

const model = new MockLanguageModelV4({
  doStream: async () =>
    ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: 'reply' },
          { type: 'text-end', id: '0' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
        chunkDelayInMs: null,
        initialDelayInMs: null,
      }),
    }) as any,
});

function mount(over: Partial<AppHooks> = {}) {
  const bridge = createApprovalBridge();
  const session = new Session({ model, askApproval: bridge.ask });
  const app = render(<App session={session} bridge={bridge} header="hdr" hooks={testHooks(over)} />);
  return { app, session };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UP = '\u001B[A';
const DOWN = '\u001B[B';

async function press(app: ReturnType<typeof render>, s: string, ms = 110) {
  app.stdin.write(s);
  await wait(ms);
}

async function type(app: ReturnType<typeof render>, s: string) {
  for (const ch of s) await press(app, ch, 60);
}

test('up arrow recalls the previous prompt', async () => {
  const { app } = mount({ history: ['earlier question'] });
  await wait(150);
  await press(app, UP);
  expect(app.lastFrame()).toContain('earlier question');
  app.unmount();
}, 10_000);

test('repeated up walks further back and down returns', async () => {
  const { app } = mount({ history: ['oldest', 'middle', 'newest'] });
  await wait(150);

  await press(app, UP);
  expect(app.lastFrame()).toContain('newest');
  await press(app, UP);
  expect(app.lastFrame()).toContain('middle');
  await press(app, UP);
  expect(app.lastFrame()).toContain('oldest');
  await press(app, DOWN);
  expect(app.lastFrame()).toContain('middle');

  app.unmount();
}, 15_000);

test('down past the newest entry restores what was being typed', async () => {
  const { app } = mount({ history: ['old'] });
  await wait(150);
  await type(app, 'draft');
  await press(app, UP);
  expect(app.lastFrame()).toContain('old');
  await press(app, DOWN);
  expect(app.lastFrame()).toContain('draft');
  app.unmount();
}, 15_000);

test('a submitted prompt is recorded and immediately recallable', async () => {
  const recorded: string[] = [];
  const { app } = mount({ recordPrompt: (t) => recorded.push(t) });
  await wait(150);

  await type(app, 'brand new');
  await press(app, '\r', 500);
  expect(recorded).toEqual(['brand new']);

  await press(app, UP);
  expect(app.lastFrame()).toContain('brand new');
  app.unmount();
}, 20_000);

test('up does nothing when there is no history', async () => {
  const { app } = mount({ history: [] });
  await wait(150);
  await press(app, UP);
  expect(app.lastFrame()).toContain('sk shiro-neko');
  app.unmount();
}, 10_000);

test('left arrow moves the cursor and typing inserts there', async () => {
  const { app, session } = mount();
  await wait(150);
  await type(app, 'ac');
  await press(app, '\u001B[D');
  await type(app, 'b');
  await press(app, '\r', 500);
  expect(session.messages[0]?.content).toBe('abc');
  app.unmount();
}, 20_000);

test('backspace deletes before the cursor', async () => {
  const { app, session } = mount();
  await wait(150);
  await type(app, 'abcX');
  await press(app, '\u007F');
  await press(app, '\r', 500);
  expect(session.messages[0]?.content).toBe('abc');
  app.unmount();
}, 20_000);

test('ctrl-u clears to the start of the line', async () => {
  const { app } = mount();
  await wait(150);
  await type(app, 'throw this away');
  await press(app, '\u0015');
  expect(app.lastFrame()).toContain('sk shiro-neko');
  app.unmount();
}, 20_000);

// Word-wise motion: the escape sequences a shell sends for ctrl-left/right.
const CTRL_LEFT = '\u001B[1;5D';
const CTRL_RIGHT = '\u001B[1;5C';

test('ctrl-left jumps the cursor back one word', async () => {
  const { app, session } = mount();
  await wait(150);
  await type(app, 'one two');
  await press(app, CTRL_LEFT);
  await type(app, 'X ');
  await press(app, '\r', 500);
  // Cursor was after "two"; a word jump puts it before it, so the X lands between.
  expect(session.messages[0]?.content).toBe('one X two');
  app.unmount();
}, 20_000);

test('ctrl-right jumps the cursor forward one word over a gap', async () => {
  const { app, session } = mount();
  await wait(150);
  await press(app, 'one two', 150);
  // Back before "one", then one word forward: the jump crosses the word and stops
  // at its end, not one character along.
  await press(app, CTRL_LEFT);
  await press(app, CTRL_LEFT);
  await press(app, CTRL_RIGHT);
  await type(app, 'X');
  await press(app, '\r', 500);
  expect(session.messages[0]?.content).toBe('oneX two');
  app.unmount();
}, 20_000);

test('a word jump over the line edge stays put', async () => {
  const { app, session } = mount();
  await wait(150);
  await type(app, 'abc');
  // Three jumps past the start: the cursor must clamp, not walk off the string.
  await press(app, CTRL_LEFT);
  await press(app, CTRL_LEFT);
  await type(app, 'X');
  await press(app, '\r', 500);
  expect(session.messages[0]?.content).toBe('Xabc');
  app.unmount();
}, 20_000);

test('ctrl-d deletes forward from the cursor', async () => {
  const { app, session } = mount();
  await wait(150);
  await type(app, 'abcd');
  // Back to the start, then delete two characters forward.
  await press(app, '\u0001');
  await press(app, '\u0004');
  await press(app, '\u0004');
  await press(app, '\r', 500);
  expect(session.messages[0]?.content).toBe('cd');
  app.unmount();
}, 20_000);

test('ctrl-d at the end of the line deletes nothing', async () => {
  const { app, session } = mount();
  await wait(150);
  await type(app, 'end');
  await press(app, '\u0004');
  await press(app, '\r', 500);
  expect(session.messages[0]?.content).toBe('end');
  app.unmount();
}, 20_000);

test('a pasted multi-character chunk is inserted whole', async () => {
  const { app, session } = mount();
  await wait(150);
  await press(app, 'pasted text here', 150);
  await press(app, '\r', 500);
  expect(session.messages[0]?.content).toBe('pasted text here');
  app.unmount();
}, 15_000);

test('/cost reports dollars for a priced model', async () => {
  const { app } = mount({ config: () => ({ provider: 'openai', model: 'gpt-5' }) });
  await wait(150);
  await type(app, 'hello');
  await press(app, '\r', 500);

  await type(app, '/cost');
  await press(app, '\r', 400);

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('1000 in / 500 out tokens');
  expect(frame).toContain('$0.0');
  app.unmount();
}, 25_000);

test('/cost says unpriced for an unknown model', async () => {
  const { app } = mount({ config: () => ({ provider: 'openai', model: 'my-local-model' }) });
  await wait(150);
  await type(app, '/cost');
  await press(app, '\r', 400);
  expect(app.lastFrame()).toContain('unpriced');
  app.unmount();
}, 20_000);

test('/context lists loaded instruction files', async () => {
  const { app } = mount({ instructionFiles: () => ['/repo/AGENTS.md', '/repo/pkg/AGENTS.md'] });
  await wait(150);
  await type(app, '/context');
  await press(app, '\r', 400);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('AGENTS.md');
  expect(frame).toContain('pkg');
  app.unmount();
}, 25_000);

test('/context points at /init when nothing is loaded', async () => {
  const { app } = mount({ instructionFiles: () => [] });
  await wait(150);
  await type(app, '/context');
  await press(app, '\r', 400);
  expect(app.lastFrame()).toContain('/init');
  app.unmount();
}, 25_000);

test('/init sends the init prompt to the model', async () => {
  const { app, session } = mount({ initPrompt: 'WRITE-AGENTS-MD-NOW' });
  await wait(150);
  await type(app, '/init');
  await press(app, '\r', 600);
  expect(session.messages[0]?.content).toBe('WRITE-AGENTS-MD-NOW');
  app.unmount();
}, 25_000);
