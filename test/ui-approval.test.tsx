import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { Approval } from '../src/ui/Approval';
import { InfoPanel, RegistryPanel, StatusBar, Working } from '../src/ui/Panels';
import { Picker } from '../src/ui/Pickers';
import { toolDetail } from '../src/ui/transcript';
import type { ApprovalRequest } from '../src/session';

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  approvalId: 'a1',
  toolName: 'bash',
  input: { command: 'echo hi' },
  suggestedPattern: '*',
  ...over,
});

const approval = (over: Partial<ApprovalRequest> = {}) =>
  render(<Approval pending={{ req: req(over), resolve: () => {} }} />);

test('an approval shows the call as readable argument lines, not a JSON dump', () => {
  const app = approval({
    toolName: 'apply_patch',
    input: { patch: '*** Update File: src/app.ts\n-a\n+b\n*** Add File: src/new.ts\n+x' },
  });

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('update src/app.ts');
  expect(frame).toContain('add src/new.ts');
  // The old prompt printed JSON.stringify(input, null, 2) for anything without a
  // diff, which for a patch is the whole patch escaped onto one line.
  expect(frame).not.toContain('"patch"');
  expect(frame).not.toContain('\\n');
  app.unmount();
});

test('every gated tool gets its own argument lines in the prompt', () => {
  const cases: [string, unknown, string][] = [
    ['bash', { command: 'bun test' }, 'bun test'],
    ['move_file', { from: 'a.ts', to: 'b.ts' }, 'a.ts -> b.ts'],
    ['delete_file', { path: 'gone.ts' }, 'gone.ts'],
    ['multi_edit', { path: 'x.ts', edits: [{ oldString: 'a' }] }, 'x.ts'],
    ['web_fetch', { url: 'https://example.com/doc' }, 'https://example.com/doc'],
  ];

  for (const [toolName, input, expected] of cases) {
    const app = approval({ toolName, input });
    expect(app.lastFrame() ?? '', toolName).toContain(expected);
    app.unmount();
  }
});

test('an approval names the tool, the grant, and both refusal keys', () => {
  const app = approval({ toolName: 'bash', suggestedPattern: 'git *' });
  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('bash wants to run');
  expect(frame).toContain('always allow bash git *');
  expect(frame).toContain('deny');
  app.unmount();
});

test('a repeated call and a subagent call each say why they stopped', () => {
  const repeated = approval({ repeated: true });
  expect(repeated.lastFrame()).toContain('repeating the same call');
  expect(repeated.lastFrame()).toContain('third identical call');
  repeated.unmount();

  const sub = approval({ subagent: true });
  expect(sub.lastFrame()).toContain('worker subagent');
  expect(sub.lastFrame()).toContain('gated by your rules');
  sub.unmount();
});

test('a panel says how to dismiss it, since nothing else on screen does', () => {
  const app = render(<InfoPanel title="tools" lines="- `read_file`" />);
  expect(app.lastFrame()).toContain('esc');
  app.unmount();

  const rows = render(
    <RegistryPanel rows={[{ name: 'deploy', kind: 'skill', description: 'ship a release' }]} />,
  );
  expect(rows.lastFrame()).toContain('esc');
  rows.unmount();
});

test('one picker component serves every chooser, opening on the current value', () => {
  const picked: string[] = [];
  const app = render(
    <Picker
      title="Choose an agent"
      hint="five variants"
      options={[
        { value: 'default', label: 'default' },
        { value: 'deep', label: 'deep' },
      ]}
      current="deep"
      onSelect={(v) => picked.push(v)}
    />,
  );

  const frame = app.lastFrame() ?? '';
  expect(frame).toContain('Choose an agent');
  expect(frame).toContain('five variants');
  expect(frame).toContain('esc to cancel');
  // Opening on the value already in use: enter without moving keeps it.
  app.stdin.write('\r');
  expect(picked).toEqual(['deep']);
  app.unmount();
});

test('the working line reports elapsed time once a turn is slow', () => {
  const quick = render(<Working seconds={2} />);
  expect(quick.lastFrame()).toContain('working');
  // Under the threshold there is no number: a count that starts at 0s is noise.
  expect(quick.lastFrame()).not.toContain('2s');
  quick.unmount();

  const slow = render(<Working seconds={47} />);
  expect(slow.lastFrame()).toContain('47s');
  expect(slow.lastFrame()).toContain('esc to interrupt');
  slow.unmount();

  const minutes = render(<Working seconds={125} />);
  expect(minutes.lastFrame()).toContain('2m 5s');
  minutes.unmount();
});

test('the status bar warns before compaction rather than after', () => {
  const fine = render(
    <StatusBar model="m" agent="default" thinking="medium" contextTokens={10} contextLimit={100} cost="$0" toolCount={1} />,
  );
  expect(fine.lastFrame()).toContain('10% ctx');
  fine.unmount();

  // At 90% the next turn may lose history, so the bar says so in words rather
  // than relying on a colour the user may not be looking at.
  const late = render(
    <StatusBar model="m" agent="default" thinking="medium" contextTokens={95} contextLimit={100} cost="$0" toolCount={1} />,
  );
  expect(late.lastFrame()).toContain('95% ctx');
  expect(late.lastFrame()).toContain('compacting soon');
  late.unmount();
});

test('toolDetail covers the tools added since it was written', () => {
  expect(toolDetail('move_file', { from: 'old.ts', to: 'new.ts' })).toEqual(['old.ts -> new.ts']);
  expect(toolDetail('delete_file', { path: 'gone.ts' })).toEqual(['gone.ts']);
  expect(toolDetail('git_branch', { remote: true })).toEqual(['local and remote']);
  expect(toolDetail('git_branch', {})).toEqual(['local']);
});
