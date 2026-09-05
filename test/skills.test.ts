import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillTool, loadSkills, parseSkill, renderSkills } from '../src/skills';
import { BUILTIN_SKILLS } from '../src/skills-builtin';

let home: string;
let work: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['SHIRO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'shiro-skill-home-'));
  work = mkdtempSync(join(tmpdir(), 'shiro-skill-work-'));
  process.env['SHIRO_HOME'] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SHIRO_HOME'];
  else process.env['SHIRO_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const load = (tool: ReturnType<typeof createSkillTool>, name: string) =>
  Promise.resolve(tool.execute!({ name } as never, { toolCallId: 'x', messages: [] } as never)) as Promise<string>;

test('frontmatter is parsed into name, description, and body', () => {
  const skill = parseSkill('---\nname: demo\ndescription: A demo skill\n---\n\n# Body\n\nDo the thing.\n', 'builtin');
  expect(skill?.name).toBe('demo');
  expect(skill?.description).toBe('A demo skill');
  expect(skill?.body).toContain('Do the thing.');
  expect(skill?.body).not.toContain('description:');
});

test('quotes around values are stripped', () => {
  const skill = parseSkill('---\nname: "quoted"\ndescription: \'also quoted\'\n---\nbody\n', 'builtin');
  expect(skill?.name).toBe('quoted');
  expect(skill?.description).toBe('also quoted');
});

test('a file without frontmatter is rejected', () => {
  expect(parseSkill('# Just markdown\n', 'builtin')).toBeUndefined();
});

test('frontmatter missing name or description is rejected', () => {
  expect(parseSkill('---\nname: only\n---\nbody\n', 'builtin')).toBeUndefined();
  expect(parseSkill('---\ndescription: only\n---\nbody\n', 'builtin')).toBeUndefined();
});

test('every bundled skill parses and has a usable description', () => {
  for (const { name, source } of BUILTIN_SKILLS) {
    const skill = parseSkill(source, 'builtin');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe(name);
    expect(skill!.description.length).toBeGreaterThan(20);
    expect(skill!.body.length).toBeGreaterThan(100);
  }
});

test('the builtin skills load with no files on disk', async () => {
  const skills = await loadSkills(work);
  expect(skills.map((s) => s.name)).toEqual([
    'commit',
    'debug',
    'migrate',
    'perf',
    'refactor',
    'review',
    'security',
    'test',
    'verify',
  ]);
  expect(skills.every((s) => s.origin === 'builtin')).toBe(true);
});

test('a project skill is discovered and reported as project origin', async () => {
  mkdirSync(join(work, '.shiro', 'skills'), { recursive: true });
  await Bun.write(join(work, '.shiro', 'skills', 'deploy.md'), '---\nname: deploy\ndescription: Ship it safely\n---\nsteps\n');

  const skills = await loadSkills(work);
  const deploy = skills.find((s) => s.name === 'deploy');
  expect(deploy?.origin).toBe('project');
  expect(deploy?.path).toContain('deploy.md');
});

test('a user skill is discovered from SHIRO_HOME', async () => {
  mkdirSync(join(home, '.shiro-neko', 'skills'), { recursive: true });
  await Bun.write(join(home, '.shiro-neko', 'skills', 'mine.md'), '---\nname: mine\ndescription: My own workflow\n---\nbody\n');

  const skills = await loadSkills(work);
  expect(skills.find((s) => s.name === 'mine')?.origin).toBe('user');
});

test('a project skill overrides a builtin with the same name', async () => {
  mkdirSync(join(work, '.shiro', 'skills'), { recursive: true });
  await Bun.write(join(work, '.shiro', 'skills', 'debug.md'), '---\nname: debug\ndescription: Project debugging rules\n---\nPROJECT-BODY\n');

  const skills = await loadSkills(work);
  const debug = skills.filter((s) => s.name === 'debug');
  expect(debug).toHaveLength(1);
  expect(debug[0]?.origin).toBe('project');
  expect(debug[0]?.body).toContain('PROJECT-BODY');
});

test('a project skill overrides a user skill of the same name', async () => {
  mkdirSync(join(home, '.shiro-neko', 'skills'), { recursive: true });
  mkdirSync(join(work, '.shiro', 'skills'), { recursive: true });
  await Bun.write(join(home, '.shiro-neko', 'skills', 'x.md'), '---\nname: x\ndescription: user version\n---\nUSER\n');
  await Bun.write(join(work, '.shiro', 'skills', 'x.md'), '---\nname: x\ndescription: project version\n---\nPROJECT\n');

  const skills = await loadSkills(work);
  expect(skills.find((s) => s.name === 'x')?.body).toBe('PROJECT');
});

test('a malformed skill file is skipped, not fatal', async () => {
  mkdirSync(join(work, '.shiro', 'skills'), { recursive: true });
  await Bun.write(join(work, '.shiro', 'skills', 'broken.md'), 'no frontmatter here\n');
  await Bun.write(join(work, '.shiro', 'skills', 'good.md'), '---\nname: good\ndescription: This one is fine\n---\nbody\n');

  const skills = await loadSkills(work);
  expect(skills.some((s) => s.name === 'good')).toBe(true);
  expect(skills).toHaveLength(BUILTIN_SKILLS.length + 1);
});

test('the catalogue carries descriptions but not bodies', async () => {
  const skills = await loadSkills(work);
  const catalog = renderSkills(skills);

  for (const s of skills) {
    expect(catalog).toContain(s.name);
    expect(catalog).toContain(s.description);
  }
  // Bodies are the expensive part and must stay out until asked for.
  expect(catalog).not.toContain('Three hypotheses');
  expect(catalog.length).toBeLessThan(skills.reduce((n, s) => n + s.body.length, 0));
});

test('an empty skill list renders nothing', () => {
  expect(renderSkills([])).toBe('');
});

test('the skill tool returns the body on demand', async () => {
  const skills = await loadSkills(work);
  const out = await load(createSkillTool(skills), 'debug');
  expect(out).toContain('Three hypotheses');
  expect(out).toContain('builtin');
});

test('the skill tool rejects an unknown name and lists what exists', async () => {
  const skills = await loadSkills(work);
  const tool = createSkillTool(skills);
  expect(load(tool, 'nonexistent')).rejects.toThrow(/No skill named "nonexistent"/);
  expect(load(tool, 'nonexistent')).rejects.toThrow(/debug/);
});

test('the skill tool tolerates surrounding whitespace and case', async () => {
  const skills = await loadSkills(work);
  const out = await load(createSkillTool(skills), '  REVIEW  ');
  expect(out).toContain('Severity order');
});
