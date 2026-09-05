import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { createAskTool } from '../src/ask';
import { applySubagentEvent } from '../src/ui/App';
import { AskPanel, createAskBridge } from '../src/ui/Ask';
import { Markdown } from '../src/ui/Markdown';
import { SubagentPanel, TodoPanel, StatusBar, InfoPanel, ActiveTool, QueuePanel, ThinkingPanel, type SubagentView } from '../src/ui/Panels';
import type { SubagentEvent } from '../src/subagent';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('markdown renders headings, bullets, and code distinctly', () => {
  const app = render(<Markdown text={'# Title\n\n- item\n\n```ts\ncode();\n```'} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('Title');
  expect(frame).toContain('item');
  expect(frame).toContain('code();');
  expect(frame).toContain('ts');
  app.unmount();
});

test('a task list renders as checkboxes, not as literal brackets', () => {
  // Models write progress as markdown task lists. Rendering "- [x] done" literally
  // turns a status report into markup noise.
  const app = render(<Markdown text={'- [x] first\n- [ ] second'} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('[x] first');
  expect(frame).toContain('[ ] second');
  app.unmount();
});

test('an ordered list keeps its numbers rather than becoming dashes', () => {
  const app = render(<Markdown text={'1. first step\n2. second step'} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('1. first step');
  expect(frame).toContain('2. second step');
  app.unmount();
});

test('markdown strips the markup characters from the rendered output', () => {
  const app = render(<Markdown text={'Use **bold** and `code` here.'} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('bold');
  expect(frame).toContain('code');
  expect(frame).not.toContain('**');
  expect(frame).not.toContain('`');
  app.unmount();
});

test('the todo panel shows a progress bar and every status', () => {
  const app = render(
    <TodoPanel
      todos={[
        { content: 'first', status: 'done' },
        { content: 'second', status: 'in_progress' },
        { content: 'third', status: 'pending' },
        { content: 'fourth', status: 'blocked', note: 'waiting on the API key' },
      ]}
      width={10}
    />,
  );
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('1/4');
  expect(frame).toContain('1 blocked');
  expect(frame).toContain('[x] first');
  expect(frame).toContain('[~] second');
  expect(frame).toContain('[ ] third');
  expect(frame).toContain('[!] fourth');
  expect(frame).toContain('waiting on the API key');
  app.unmount();
});

test('the subagent panel shows the last few steps of a running agent', () => {
  const agents: SubagentView[] = [
    {
      id: 'sub1',
      kind: 'explore',
      description: 'find auth handlers',
      steps: [
        { tool: 'glob', summary: 'src/**/*.ts' },
        { tool: 'grep', summary: 'login' },
        { tool: 'read_file', summary: 'src/auth.ts' },
      ],
      status: 'running',
    },
  ];
  const app = render(<SubagentPanel agents={agents} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('explore');
  expect(frame).toContain('find auth handlers');
  expect(frame).toContain('3 steps');
  expect(frame).toContain('grep(login)');
  app.unmount();
});

test('a failed subagent shows its error', () => {
  const app = render(
    <SubagentPanel
      agents={[{ id: 's', kind: 'review', description: 'review diff', steps: [], status: 'failed', error: 'model refused' }]}
    />,
  );
  expect(app.lastFrame()).toContain('model refused');
  app.unmount();
});

test('an empty subagent panel renders nothing', () => {
  const app = render(<SubagentPanel agents={[]} />);
  expect(app.lastFrame() ?? '').toBe('');
  app.unmount();
});

test('the status bar reports model, agent, thinking, context, and spend', () => {
  const app = render(
    <StatusBar model="gpt-5" agent="deep" thinking="max" contextTokens={1234} cost="$0.42" toolCount={13} />,
  );
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('gpt-5');
  expect(frame).toContain('deep');
  expect(frame).toContain('max');
  expect(frame).toContain('1234');
  expect(frame).toContain('$0.42');
  expect(frame).toContain('13 tools');
  app.unmount();
});

test('a context limit turns the raw token count into a percentage', () => {
  const app = render(
    <StatusBar
      model="gpt-5"
      agent="default"
      thinking="medium"
      contextTokens={60_000}
      contextLimit={120_000}
      cost="$0.10"
      toolCount={14}
    />,
  );
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('50% ctx');
  expect(frame).not.toContain('60000');
  app.unmount();
});

test('the context percentage is capped at 100 rather than running over', () => {
  const app = render(
    <StatusBar
      model="m"
      agent="a"
      thinking="t"
      contextTokens={300_000}
      contextLimit={120_000}
      cost="$1"
      toolCount={1}
    />,
  );
  expect(app.lastFrame()).toContain('100% ctx');
  app.unmount();
});

test('the info panel renders a markdown body', () => {
  const app = render(<InfoPanel title="tools" hint="7 offered" lines={'- `read_file`\n- `bash`'} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('tools');
  expect(frame).toContain('7 offered');
  expect(frame).toContain('read_file');
  expect(frame).not.toContain('`');
  app.unmount();
});

test('the active tool line names the tool and the file it is touching', () => {
  const app = render(<ActiveTool name="read_file" detail={['src/session.ts']} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('read_file');
  expect(frame).toContain('src/session.ts');
  app.unmount();
});

test('the active tool line renders before the arguments have arrived', () => {
  const app = render(<ActiveTool name="grep" />);
  expect(app.lastFrame()).toContain('grep');
  app.unmount();
});

test('the active tool line shows several detail lines and caps the rest', () => {
  const detail = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`);
  const app = render(<ActiveTool name="read_many_files" detail={detail} />);
  const frame = app.lastFrame() ?? '';
  // One line is never enough for a batch read: which paths are about to enter the
  // context is the whole point of showing it.
  expect(frame).toContain('src/file0.ts');
  expect(frame).toContain('src/file5.ts');
  expect(frame).toContain('3 more');
  app.unmount();
});

test('thinking collapses to a token count, and expands on request', () => {
  const text = 'x'.repeat(1648);
  const collapsed = render(<ThinkingPanel text={text} />);
  expect(collapsed.lastFrame()).toContain('~412 tokens');
  expect(collapsed.lastFrame()).not.toContain('xxxx');
  collapsed.unmount();

  const open = render(<ThinkingPanel text={'first line\nsecond line'} expanded />);
  const frame = open.lastFrame() ?? '';
  expect(frame).toContain('second line');
  expect(frame).toContain('collapse');
  open.unmount();
});

test('no reasoning renders nothing at all', () => {
  const app = render(<ThinkingPanel text="" />);
  expect(app.lastFrame() ?? '').toBe('');
  app.unmount();
});

test('the queue panel counts what is waiting and lists it in order', () => {
  const app = render(<QueuePanel prompts={['first thing', 'second thing']} />);
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('queued: 2');
  expect(frame).toContain('1. first thing');
  expect(frame).toContain('2. second thing');
  app.unmount();
});

test('an empty queue renders nothing', () => {
  const app = render(<QueuePanel prompts={[]} />);
  expect(app.lastFrame() ?? '').toBe('');
  app.unmount();
});

const events: SubagentEvent[] = [
  { type: 'start', id: 'a', kind: 'explore', description: 'first task' },
  { type: 'step', id: 'a', tool: 'grep', summary: 'needle' },
  { type: 'start', id: 'b', kind: 'review', description: 'second task' },
  { type: 'end', id: 'a', ok: true, steps: 1 },
  { type: 'error', id: 'b', message: 'exploded' },
];

test('subagent events fold into the panel view', () => {
  const view = events.reduce(applySubagentEvent, [] as SubagentView[]);
  expect(view).toHaveLength(2);
  expect(view[0]).toMatchObject({ id: 'a', status: 'done', steps: [{ tool: 'grep', summary: 'needle' }] });
  expect(view[1]).toMatchObject({ id: 'b', status: 'failed', error: 'exploded' });
});

test('a subagent result attaches to its step without clearing the panel state', () => {
  const started = applySubagentEvent([], { type: 'start', id: 'a', kind: 'explore', description: 'find auth' });
  const stepped = applySubagentEvent(started, { type: 'step', id: 'a', tool: 'grep', summary: 'login' });
  const view = applySubagentEvent(stepped, { type: 'result', id: 'a', tool: 'grep', summary: '2 hits', ok: true });

  expect(view).toHaveLength(1);
  expect(view[0]).toMatchObject({
    id: 'a',
    steps: [{ tool: 'grep', summary: 'login', outcome: '2 hits', ok: true }],
  });
});

test('an event for an unknown id is ignored rather than throwing', () => {
  const view = applySubagentEvent([], { type: 'step', id: 'ghost', tool: 'grep', summary: 'x' });
  expect(view).toEqual([]);
});

test('the ask tool refuses when nothing can answer', async () => {
  const t = createAskTool(undefined);
  expect(
    Promise.resolve(t.execute!({ question: 'which one?' } as never, { toolCallId: 'x', messages: [] } as never)),
  ).rejects.toThrow(/headless/);
});

test('the ask tool returns the chosen options', async () => {
  const t = createAskTool(async () => ['Option B']);
  const out = await (t.execute!(
    { question: 'A or B?', options: [{ label: 'Option A' }, { label: 'Option B' }] } as never,
    { toolCallId: 'x', messages: [] } as never,
  ) as Promise<string>);
  expect(out).toContain('Option B');
});

test('a dismissed question tells the model to decide for itself', async () => {
  const t = createAskTool(async () => undefined);
  const out = await (t.execute!({ question: 'anything?' } as never, {
    toolCallId: 'x',
    messages: [],
  } as never) as Promise<string>);
  expect(out).toContain('dismissed');
  expect(out).toContain('best judgement');
});

test('the ask bridge resolves undefined when no UI is bound', async () => {
  const bridge = createAskBridge();
  expect(await bridge.ask({ question: 'q', multiple: false })).toBeUndefined();
});

test('the ask panel shows the question and its options', () => {
  const app = render(
    <AskPanel
      pending={{
        req: {
          question: 'Which storage layer?',
          options: [
            { label: 'Postgres', detail: 'relational, needs a migration' },
            { label: 'SQLite', detail: 'zero setup' },
          ],
          multiple: false,
        },
        resolve: () => {},
      }}
    />,
  );
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('shiro is asking');
  expect(frame).toContain('Which storage layer?');
  expect(frame).toContain('Postgres');
  expect(frame).toContain('SQLite');
  app.unmount();
});

test('choosing an option resolves the question', async () => {
  const answers: (string[] | undefined)[] = [];
  const app = render(
    <AskPanel
      pending={{
        req: { question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }], multiple: false },
        resolve: (a) => answers.push(a),
      }}
    />,
  );
  await wait(120);
  app.stdin.write('\r');
  await wait(200);

  expect(answers).toEqual([['A']]);
  app.unmount();
}, 10_000);

test('esc dismisses the question with no answer', async () => {
  const answers: (string[] | undefined)[] = [];
  const app = render(
    <AskPanel
      pending={{
        req: { question: 'anything?', options: [{ label: 'A' }], multiple: false },
        resolve: (a) => answers.push(a),
      }}
    />,
  );
  await wait(120);
  app.stdin.write('\u001B');
  await wait(200);

  expect(answers).toEqual([undefined]);
  app.unmount();
}, 10_000);

test('a question with no options goes straight to free text', async () => {
  const answers: (string[] | undefined)[] = [];
  const app = render(
    <AskPanel pending={{ req: { question: 'name it', multiple: false }, resolve: (a) => answers.push(a) }} />,
  );
  await wait(120);
  expect(app.lastFrame()).toContain('ype your answer');

  for (const ch of 'shiro') {
    app.stdin.write(ch);
    await wait(40);
  }
  app.stdin.write('\r');
  await wait(200);

  expect(answers).toEqual([['shiro']]);
  app.unmount();
}, 15_000);
