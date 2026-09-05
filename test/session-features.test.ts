import { expect, test } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { variantByName } from '../src/agents';
import { createCommitMessageTool } from '../src/commit';
import { Memory } from '../src/memory';
import { createHost } from '../src/plugins';
import { guardPlugin, timePlugin } from '../src/plugins-builtin';
import { Session } from '../src/session';
import { loadSkills } from '../src/skills';
import { MUTATING_TOOLS, TOOL_SETS, TOOL_SET_NAMES, isToolSetName, toolSetOf } from '../src/tools';
import { GIT_TOOL_NAMES } from '../src/tools-git';

function inTempDir<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'shiro-perm-'));
  process.chdir(dir);
  return fn().finally(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });
}

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2 },
} as any;

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null, initialDelayInMs: null }),
});

const toolCall = (id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] => [
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];

const text = (body: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: body },
  { type: 'text-end', id: '0' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

function recorder() {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      seen.push(o);
      return stream(text('ok'));
    },
  });
  return { seen, model };
}

test('the thinking level reaches the provider call', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', agent: variantByName('deep') });
  for await (const _ of session.send('hi')) void _;
  expect(seen[0]?.reasoning).toBe('xhigh');
});

test('the quick variant asks for no thinking at all', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', agent: variantByName('quick') });
  for await (const _ of session.send('hi')) void _;
  expect(seen[0]?.reasoning).toBe('none');
});

test('switching the agent mid-session changes the next call', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny' });

  for await (const _ of session.send('first')) void _;
  expect(seen[0]?.reasoning).toBe('medium');

  session.setAgent(variantByName('deep')!);
  for await (const _ of session.send('second')) void _;
  expect(seen[1]?.reasoning).toBe('xhigh');
});

test('a read-only variant hides the mutating tools from the model', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', agent: variantByName('plan') });
  for await (const _ of session.send('investigate')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  expect(offered).toContain('read_file');
  expect(offered).toContain('grep');
  expect(offered).not.toContain('write_file');
  expect(offered).not.toContain('edit_file');
  expect(offered).not.toContain('bash');
});

test('the default variant offers everything', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny' });
  for await (const _ of session.send('go')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  expect(offered).toContain('bash');
  expect(offered).toContain('write_file');
});

test('the variant appendix reaches the system prompt', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', agent: variantByName('review') });
  for await (const _ of session.send('review it')) void _;

  expect(JSON.stringify(seen[0]?.prompt.find((m) => m.role === 'system'))).toContain('reviewing code');
});

test('a variant maxSteps overrides the session default', async () => {
  const { model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', agent: variantByName('quick'), maxSteps: 99 });
  expect(session.agent().maxSteps).toBe(12);
});

test('the skill catalogue and skill tool are offered when skills are loaded', async () => {
  const { seen, model } = recorder();
  const skills = await loadSkills(process.cwd());
  const session = new Session({ model, askApproval: async () => 'deny', skills });
  for await (const _ of session.send('hi')) void _;

  expect((seen[0]?.tools ?? []).map((t) => t.name)).toContain('skill');
  const system = JSON.stringify(seen[0]?.prompt.find((m) => m.role === 'system'));
  expect(system).toContain('debug');
  expect(system).toContain('Skills available');
});

test('no skill tool is offered when there are no skills', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', skills: [] });
  for await (const _ of session.send('hi')) void _;
  expect((seen[0]?.tools ?? []).map((t) => t.name)).not.toContain('skill');
});

test('the skill tool never needs approval', async () => {
  let n = 0;
  const skills = await loadSkills(process.cwd());
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => (n++ === 0 ? stream(toolCall('c1', 'skill', { name: 'debug' })) : stream(text('loaded'))),
    }),
    askApproval: async () => {
      throw new Error('skill must not prompt');
    },
    skills,
  });

  const kinds: string[] = [];
  for await (const ev of session.send('debug this')) kinds.push(ev.type);
  expect(kinds).toContain('tool-result');
  expect(kinds).not.toContain('tool-denied');
});

test('memory tools are offered and never prompt', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', memory: new Memory('/repo-test') });
  for await (const _ of session.send('hi')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  expect(offered).toContain('remember');
  expect(offered).toContain('recall');
  expect(offered).toContain('forget');
});

test('plugin tools reach the model and are auto-approved', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', plugins: createHost([timePlugin]) });
  for await (const _ of session.send('what time is it')) void _;
  expect((seen[0]?.tools ?? []).map((t) => t.name)).toContain('current_time');
});

test('the plugin appendix reaches the system prompt', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', plugins: createHost([guardPlugin]) });
  for await (const _ of session.send('hi')) void _;
  expect(JSON.stringify(seen[0]?.prompt.find((m) => m.role === 'system'))).toContain('refuses irreversible');
});

test('the guard blocks a destructive bash call without asking the user', async () => {
  let asked = 0;
  let n = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () =>
        n++ === 0 ? stream(toolCall('c1', 'bash', { command: 'rm -rf /' })) : stream(text('understood')),
    }),
    askApproval: async () => {
      asked++;
      return 'once';
    },
    plugins: createHost([guardPlugin]),
  });

  const events: string[] = [];
  const notices: string[] = [];
  for await (const ev of session.send('clean up')) {
    events.push(ev.type);
    if (ev.type === 'notice') notices.push(ev.text);
  }

  expect(asked).toBe(0);
  expect(events).toContain('notice');
  expect(events).toContain('tool-denied');
  expect(notices.join()).toContain('recursive or forced delete');
});

test('a safe bash call still reaches the approval prompt', async () => {
  let asked = 0;
  let n = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => (n++ === 0 ? stream(toolCall('c1', 'bash', { command: 'echo hi' })) : stream(text('done'))),
    }),
    askApproval: async () => {
      asked++;
      return 'once';
    },
    plugins: createHost([guardPlugin]),
  });

  for await (const _ of session.send('say hi')) void _;
  expect(asked).toBe(1);
});

test('afterTurn fires once the turn ends', async () => {
  let fired = 0;
  const { model } = recorder();
  const session = new Session({
    model,
    askApproval: async () => 'deny',
    plugins: createHost([{ name: 'counter', description: '', afterTurn: () => void fired++ }]),
  });

  for await (const _ of session.send('hi')) void _;
  expect(fired).toBe(1);
});

test('the git tools are offered by default and never prompt', async () => {
  const { seen, model } = recorder();
  // git_commit_message is model-built, so it joins through extraTools the way
  // cli.tsx wires it; the static five come with the session.
  const session = new Session({
    model,
    askApproval: async () => {
      throw new Error('a git tool must never prompt');
    },
    extraTools: { git_commit_message: createCommitMessageTool({ model }) },
  });
  for await (const _ of session.send('what changed')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  for (const name of GIT_TOOL_NAMES) expect(offered).toContain(name);
  for (const name of GIT_TOOL_NAMES) expect(MUTATING_TOOLS as readonly string[]).not.toContain(name);
});

test('a disabled tool set reaches neither the wire nor the prompt', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', toolSets: [] });
  for await (const _ of session.send('hi')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  expect(offered).toContain('read_file');
  expect(offered).toContain('bash');
  expect(offered).not.toContain('git_status');
  expect(offered).not.toContain('multi_edit');
  expect(offered).not.toContain('list_dir');

  const system = JSON.stringify(seen[0]?.prompt.find((m) => m.role === 'system'));
  expect(system).not.toContain('git_status');
  expect(system).not.toContain('multi_edit');
});

test('an enabled set is offered while the others stay withheld', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', toolSets: ['git'] });
  for await (const _ of session.send('hi')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  expect(offered).toContain('git_diff');
  expect(offered).not.toContain('multi_edit');
});

test('core is never withheld, whatever the config says', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', toolSets: ['git'] });
  for await (const _ of session.send('hi')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  for (const name of TOOL_SETS.core) expect(offered).toContain(name);
});

test('session tools survive tool-set gating, since they are not part of that budget', async () => {
  const { seen, model } = recorder();
  const session = new Session({ model, askApproval: async () => 'deny', toolSets: [], memory: new Memory('/repo-test') });
  for await (const _ of session.send('hi')) void _;

  const offered = (seen[0]?.tools ?? []).map((t) => t.name);
  expect(offered).toContain('todo_write');
  expect(offered).toContain('remember');
});

test('toolSetOf names the set a tool came from, and nothing for a session tool', () => {
  expect(toolSetOf('read_file')).toBe('core');
  expect(toolSetOf('multi_edit')).toBe('edit-plus');
  expect(toolSetOf('git_log')).toBe('git');
  expect(toolSetOf('todo_write')).toBeUndefined();
});

test('isToolSetName accepts the real sets only, so a typo in config is ignored', () => {
  for (const name of TOOL_SET_NAMES) expect(isToolSetName(name)).toBe(true);
  expect(isToolSetName('gti')).toBe(false);
});

const bashCall = (id: string, command: string) => toolCall(id, 'bash', { command });

test('a pattern that allows skips the prompt entirely', async () => {
  let n = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => (n++ === 0 ? stream(bashCall('c1', 'echo allowed')) : stream(text('done'))),
    }),
    askApproval: async () => {
      throw new Error('an allowed pattern must not prompt');
    },
    permissions: { bash: { '*': 'ask', 'echo *': 'allow' } },
  });

  const kinds: string[] = [];
  for await (const ev of session.send('say something')) kinds.push(ev.type);
  expect(kinds).toContain('tool-result');
  expect(kinds).not.toContain('tool-denied');
});

test('a pattern that denies refuses without asking, and the tool never runs', async () =>
  inTempDir(async () => {
    let asked = 0;
    let n = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () =>
          n++ === 0 ? stream(bashCall('c1', 'rm -rf build > out.txt')) : stream(text('understood')),
      }),
      askApproval: async () => {
        asked++;
        return 'once';
      },
      // Deliberately not the guard plugin: this is the rule engine refusing.
      plugins: undefined,
      permissions: { bash: { '*': 'ask', 'rm *': 'deny' } },
    });

    const events: string[] = [];
    const notices: string[] = [];
    for await (const ev of session.send('clean up')) {
      events.push(ev.type);
      if (ev.type === 'notice') notices.push(ev.text);
    }

    expect(asked).toBe(0);
    expect(events).toContain('tool-denied');
    expect(notices.join()).toContain('"rm *" = deny');
    expect(await Bun.file(join(process.cwd(), 'out.txt')).exists()).toBe(false);
  }));

test('a command outside the allowed pattern still asks', async () => {
  const asked: string[] = [];
  let n = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => (n++ === 0 ? stream(bashCall('c1', 'npm publish')) : stream(text('done'))),
    }),
    askApproval: async (req) => {
      asked.push(req.toolName);
      return 'deny';
    },
    permissions: { bash: { '*': 'ask', 'git *': 'allow' } },
  });

  for await (const _ of session.send('publish it')) void _;
  expect(asked).toEqual(['bash']);
});

test('always records the suggested pattern, so a sibling command runs unprompted', async () => {
  const asked: string[] = [];
  let n = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => {
        const i = n++;
        if (i === 0) return stream(bashCall('c1', 'git status'));
        if (i === 1) return stream(bashCall('c2', 'git log'));
        if (i === 2) return stream(bashCall('c3', 'npm test'));
        return stream(text('done'));
      },
    }),
    askApproval: async (req) => {
      asked.push(String((req.input as { command?: string }).command));
      return req.suggestedPattern === 'git *' ? 'always' : 'deny';
    },
  });

  for await (const _ of session.send('inspect the repo')) void _;

  // git status is approved as `git *`, so git log never reaches the prompt.
  expect(asked).toEqual(['git status', 'npm test']);
});

test('the prompt carries the pattern that matched and what always would grant', async () => {
  const seen: { matched?: string; suggested: string }[] = [];
  let n = 0;
  const session = new Session({
    model: new MockLanguageModelV4({
      doStream: async () => (n++ === 0 ? stream(bashCall('c1', 'npm test')) : stream(text('done'))),
    }),
    askApproval: async (req) => {
      seen.push({ ...(req.matchedPattern ? { matched: req.matchedPattern } : {}), suggested: req.suggestedPattern });
      return 'deny';
    },
    permissions: { bash: { '*': 'ask' } },
  });

  for await (const _ of session.send('test it')) void _;
  expect(seen).toEqual([{ matched: '*', suggested: 'npm *' }]);
});

test('a third identical call is asked about even when the rules allow it', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'note.txt'), 'hello');

    const asked: boolean[] = [];
    let n = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => {
          const i = n++;
          return i < 4 ? stream(toolCall(`c${i}`, 'read_file', { path: 'note.txt' })) : stream(text('done'));
        },
      }),
      askApproval: async (req) => {
        asked.push(req.repeated === true);
        return 'once';
      },
    });

    for await (const _ of session.send('read it repeatedly')) void _;

    // Two identical reads pass; the third and fourth are asked about, flagged as
    // repeats rather than as rule matches.
    expect(asked).toEqual([true, true]);
  }));

test('the repeat guard counts per turn, not for the life of the session', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), 'note.txt'), 'hello');

    let asks = 0;
    let n = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => {
          const i = n++ % 3;
          return i < 2 ? stream(toolCall(`c${i}`, 'read_file', { path: 'note.txt' })) : stream(text('done'));
        },
      }),
      askApproval: async () => {
        asks++;
        return 'once';
      },
    });

    for await (const _ of session.send('first turn')) void _;
    for await (const _ of session.send('second turn')) void _;

    // Two reads per turn, twice: never three in one turn, so never asked.
    expect(asks).toBe(0);
  }));

test('the guard plugin still refuses ahead of the rules, and yolo cannot reach it', async () => {
  let asked = 0;
  let n = 0;
  const session = new Session({
    yolo: true,
    model: new MockLanguageModelV4({
      doStream: async () => (n++ === 0 ? stream(bashCall('c1', 'rm -rf /')) : stream(text('understood'))),
    }),
    askApproval: async () => {
      asked++;
      return 'once';
    },
    plugins: createHost([guardPlugin]),
    permissions: { bash: 'allow' },
  });

  const notices: string[] = [];
  for await (const ev of session.send('clean up')) if (ev.type === 'notice') notices.push(ev.text);

  expect(asked).toBe(0);
  expect(notices.join()).toContain('recursive or forced delete');
});

test('reading a credential is refused by default', async () =>
  inTempDir(async () => {
    await Bun.write(join(process.cwd(), '.env'), 'SECRET=hunter2');

    let n = 0;
    const session = new Session({
      model: new MockLanguageModelV4({
        doStream: async () => (n++ === 0 ? stream(toolCall('c1', 'read_file', { path: '.env' })) : stream(text('ok'))),
      }),
      askApproval: async () => {
        throw new Error('a denied read must not prompt');
      },
    });

    const events: string[] = [];
    const notices: string[] = [];
    for await (const ev of session.send('read the env file')) {
      events.push(ev.type);
      if (ev.type === 'notice') notices.push(ev.text);
    }

    expect(events).toContain('tool-denied');
    expect(notices.join()).toContain('deny');
    // The secret must not reach the transcript either.
    expect(JSON.stringify(session.messages)).not.toContain('hunter2');
  }));

