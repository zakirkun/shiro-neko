import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPatchTool,
  bashTool,
  deleteFileTool,
  editFileTool,
  globTool,
  grepTool,
  interruptBash,
  jail,
  listDirTool,
  moveFileTool,
  multiEditTool,
  MUTATING_TOOLS,
  onBashOutput,
  parsePatch,
  readFileTool,
  readManyFilesTool,
  tools,
  toolSetOf,
  writeFileTool,
} from '../src/tools';

let dir: string;
let origCwd: string;

/** Tools resolve paths against process.cwd(), so each test runs inside a temp workspace. */
beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'shiro-'));
  process.chdir(dir);
});

afterEach(() => {
  onBashOutput(undefined);
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

const run = <T>(t: { execute?: (input: T, opts: any) => unknown }, input: T) =>
  Promise.resolve(t.execute!(input, { toolCallId: 't1', messages: [] })) as Promise<string>;

test('jail rejects traversal and absolute escapes', () => {
  expect(() => jail('../secret')).toThrow(/escapes workspace/);
  expect(() => jail('a/../../secret')).toThrow(/escapes workspace/);
  expect(jail('a/b.ts')).toBe(join(process.cwd(), 'a', 'b.ts'));
});

test('read_file numbers lines and honours offset/limit', async () => {
  await Bun.write(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  expect(await run(readFileTool, { path: 'a.txt' })).toBe('1: one\n2: two\n3: three\n4: ');
  expect(await run(readFileTool, { path: 'a.txt', offset: 2, limit: 1 })).toBe('2: two');
});

test('read_file on missing path throws', async () => {
  expect(run(readFileTool, { path: 'nope.txt' })).rejects.toThrow(/No such file/);
});

test('read_file refuses a binary file instead of dumping mojibake', async () => {
  await Bun.write(join(dir, 'blob.bin'), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));
  expect(run(readFileTool, { path: 'blob.bin' })).rejects.toThrow(/binary file/);
});

test('read_file still accepts UTF-8 with high codepoints', async () => {
  await Bun.write(join(dir, 'u.txt'), 'hello -> world\n');
  expect(await run(readFileTool, { path: 'u.txt' })).toContain('hello -> world');
});

test('read_many_files returns one labelled block per file', async () => {
  await Bun.write(join(dir, 'a.ts'), 'const a = 1;\n');
  await Bun.write(join(dir, 'b.ts'), 'const b = 2;\n');

  const out = await run(readManyFilesTool, { files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
  expect(out).toContain('===== a.ts =====');
  expect(out).toContain('1: const a = 1;');
  expect(out).toContain('===== b.ts =====');
  expect(out).toContain('1: const b = 2;');
});

test('read_many_files keeps the order it was given', async () => {
  await Bun.write(join(dir, 'first.ts'), 'x\n');
  await Bun.write(join(dir, 'second.ts'), 'y\n');

  const out = await run(readManyFilesTool, { files: [{ path: 'second.ts' }, { path: 'first.ts' }] });
  expect(out.indexOf('second.ts')).toBeLessThan(out.indexOf('first.ts'));
});

test('read_many_files honours a per-file offset and limit', async () => {
  await Bun.write(join(dir, 'long.ts'), 'one\ntwo\nthree\nfour\n');
  const out = await run(readManyFilesTool, { files: [{ path: 'long.ts', offset: 2, limit: 2 }] });
  expect(out).toContain('2: two');
  expect(out).toContain('3: three');
  expect(out).not.toContain('1: one');
  expect(out).not.toContain('4: four');
});

test('an unreadable path is named in its own block without aborting the rest', async () => {
  await Bun.write(join(dir, 'good.ts'), 'fine\n');
  await Bun.write(join(dir, 'blob.bin'), new Uint8Array([0x00, 0x01, 0x02]));

  const out = await run(readManyFilesTool, {
    files: [{ path: 'good.ts' }, { path: 'gone.ts' }, { path: 'blob.bin' }],
  });

  expect(out).toContain('1: fine');
  expect(out).toContain('===== gone.ts =====');
  expect(out).toContain('No such file: gone.ts');
  expect(out).toContain('binary file');
});

test('read_many_files refuses a path outside the workspace', async () => {
  expect(run(readManyFilesTool, { files: [{ path: '../escape.ts' }] })).resolves.toContain('escapes workspace');
});

test('edit_file replaces a unique occurrence', async () => {
  await Bun.write(join(dir, 'x.ts'), 'const a = 1;\nconst b = 2;\n');
  await run(editFileTool, { path: 'x.ts', oldString: 'const b = 2;', newString: 'const b = 3;' });
  expect(await Bun.file(join(dir, 'x.ts')).text()).toBe('const a = 1;\nconst b = 3;\n');
});

test('edit_file refuses ambiguous oldString unless replaceAll', async () => {
  await Bun.write(join(dir, 'y.ts'), 'x\nx\n');
  expect(run(editFileTool, { path: 'y.ts', oldString: 'x', newString: 'z' })).rejects.toThrow(/appears 2 times/);

  await run(editFileTool, { path: 'y.ts', oldString: 'x', newString: 'z', replaceAll: true });
  expect(await Bun.file(join(dir, 'y.ts')).text()).toBe('z\nz\n');
});

test('edit_file reports a missing oldString', async () => {
  await Bun.write(join(dir, 'z.ts'), 'hello');
  expect(run(editFileTool, { path: 'z.ts', oldString: 'bye', newString: 'hi' })).rejects.toThrow(/not found/);
});

test('write_file then glob and grep find the content', async () => {
  await run(writeFileTool, { path: 'src/app.ts', content: 'export const port = 8080;\n' });
  expect(await run(globTool, { pattern: 'src/**/*.ts' })).toBe('src/app.ts');
  expect(await run(grepTool, { pattern: 'port = \\d+', include: '**/*.ts' })).toBe(
    'src/app.ts:1: export const port = 8080;',
  );
});

test('overwriting a file with collapsed whitespace is flagged in the result', async () => {
  const before = [
    "@extends('layouts.app')",
    "@section('content')",
    '<section class="page-hero">',
    '    <div class="container">',
    '        <p>Explore homes</p>',
    '    </div>',
    '</section>',
    '@endsection',
    '',
  ].join('\n');
  await Bun.write(join(dir, 'index.blade.php'), before);

  // What a compressed rewrite looks like: the same markup, most newlines gone.
  const collapsed = before.replace(/\n\s*/g, '');
  const out = await run(writeFileTool, { path: 'index.blade.php', content: collapsed });

  expect(out).toContain('Wrote');
  expect(out).toContain('newline');
  expect(await Bun.file(join(dir, 'index.blade.php')).text()).toBe(collapsed);
});

test('a normal rewrite is not flagged', async () => {
  await Bun.write(join(dir, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
  const out = await run(writeFileTool, { path: 'a.ts', content: 'const a = 10;\nconst b = 20;\n' });
  expect(out).toBe('Wrote 28 chars to a.ts');

  // And a genuine deletion is not either: fewer lines is fine when the content
  // is also much shorter — the flag is for whitespace collapse, not truncation.
  await Bun.write(join(dir, 'b.ts'), 'line 1\nline 2\nline 3\n');
  const short = await run(writeFileTool, { path: 'b.ts', content: 'line 1\n' });
  expect(short).toBe('Wrote 7 chars to b.ts');
});

test('move_file renames a file and creates the parent directory', async () => {
  await Bun.write(join(dir, 'old.ts'), 'export const a = 1;\n');

  const out = await run(moveFileTool, { from: 'old.ts', to: 'src/new.ts' });

  expect(out).toContain('old.ts');
  expect(out).toContain('src/new.ts');
  expect(await Bun.file(join(dir, 'src/new.ts')).text()).toBe('export const a = 1;\n');
  expect(await Bun.file(join(dir, 'old.ts')).exists()).toBe(false);
});

test('move_file refuses a missing source and an occupied target', async () => {
  await Bun.write(join(dir, 'one.ts'), 'a\n');
  await Bun.write(join(dir, 'two.ts'), 'b\n');

  expect(run(moveFileTool, { from: 'gone.ts', to: 'x.ts' })).rejects.toThrow(/no such file/i);
  expect(run(moveFileTool, { from: 'one.ts', to: 'two.ts' })).rejects.toThrow(/already exists/i);

  // Neither refusal may have touched anything.
  expect(await Bun.file(join(dir, 'one.ts')).text()).toBe('a\n');
  expect(await Bun.file(join(dir, 'two.ts')).text()).toBe('b\n');
});

test('move_file refuses either path outside the workspace', async () => {
  await Bun.write(join(dir, 'in.ts'), 'x\n');
  expect(run(moveFileTool, { from: 'in.ts', to: '../escaped.ts' })).rejects.toThrow(/escapes workspace/);
  expect(run(moveFileTool, { from: '../../etc/passwd', to: 'here.ts' })).rejects.toThrow(/escapes workspace/);
});

test('delete_file removes one file and reports it', async () => {
  await Bun.write(join(dir, 'gone.ts'), 'x\n');

  const out = await run(deleteFileTool, { path: 'gone.ts' });

  expect(out).toContain('gone.ts');
  expect(await Bun.file(join(dir, 'gone.ts')).exists()).toBe(false);
});

test('delete_file refuses a missing file, a directory, and an escaping path', async () => {
  await Bun.write(join(dir, 'sub/keep.ts'), 'x\n');

  expect(run(deleteFileTool, { path: 'nope.ts' })).rejects.toThrow(/no such file/i);
  // A directory delete is recursive by nature, which is the one thing this must
  // not do quietly: that is the guard plugin's `rm -rf` case.
  expect(run(deleteFileTool, { path: 'sub' })).rejects.toThrow(/directory/i);
  expect(run(deleteFileTool, { path: '../outside.ts' })).rejects.toThrow(/escapes workspace/);

  expect(await Bun.file(join(dir, 'sub/keep.ts')).exists()).toBe(true);
});

test('both new write tools are gated and belong to a set', () => {
  for (const name of ['move_file', 'delete_file']) {
    expect(MUTATING_TOOLS as readonly string[]).toContain(name);
    expect(toolSetOf(name)).toBe('edit-plus');
    expect(Object.keys(tools)).toContain(name);
  }
});

test('multi_edit applies every edit in order, each seeing the last', async () => {
  await Bun.write(join(dir, 'm.ts'), 'const a = 1;\nconst b = 2;\n');
  const out = await run(multiEditTool, {
    path: 'm.ts',
    edits: [
      { oldString: 'const a = 1;', newString: 'const a = 10;' },
      { oldString: 'const a = 10;\nconst b = 2;', newString: 'const a = 10;\nconst b = 20;' },
    ],
  });

  expect(out).toContain('2 edit(s)');
  expect(await Bun.file(join(dir, 'm.ts')).text()).toBe('const a = 10;\nconst b = 20;\n');
});

test('a failing second edit leaves the file exactly as it was', async () => {
  const before = 'const a = 1;\nconst b = 2;\n';
  await Bun.write(join(dir, 'm.ts'), before);

  expect(
    run(multiEditTool, {
      path: 'm.ts',
      edits: [
        { oldString: 'const a = 1;', newString: 'const a = 10;' },
        { oldString: 'const NOPE = 0;', newString: 'x' },
      ],
    }),
  ).rejects.toThrow(/edit 2: oldString not found/);

  await Bun.sleep(20);
  expect(await Bun.file(join(dir, 'm.ts')).text()).toBe(before);
});

test('multi_edit refuses an ambiguous match unless replaceAll, writing nothing', async () => {
  const before = 'x\nx\n';
  await Bun.write(join(dir, 'a.ts'), before);

  expect(
    run(multiEditTool, { path: 'a.ts', edits: [{ oldString: 'x', newString: 'y' }] }),
  ).rejects.toThrow(/appears 2 times/);
  await Bun.sleep(20);
  expect(await Bun.file(join(dir, 'a.ts')).text()).toBe(before);

  await run(multiEditTool, { path: 'a.ts', edits: [{ oldString: 'x', newString: 'y', replaceAll: true }] });
  expect(await Bun.file(join(dir, 'a.ts')).text()).toBe('y\ny\n');
});

test('multi_edit reports a missing file rather than creating one', async () => {
  expect(
    run(multiEditTool, { path: 'gone.ts', edits: [{ oldString: 'a', newString: 'b' }] }),
  ).rejects.toThrow(/No such file/);
  expect(await Bun.file(join(dir, 'gone.ts')).exists()).toBe(false);
});

test('list_dir shows a tree with sizes and marks directories', async () => {
  await Bun.write(join(dir, 'src/app.ts'), 'x'.repeat(2048));
  await Bun.write(join(dir, 'readme.md'), 'hi');

  const out = await run(listDirTool, {});
  expect(out).toContain('src/');
  expect(out).toContain('app.ts');
  expect(out).toContain('2K');
  expect(out).toContain('readme.md  2B');
});

test('list_dir stops at the depth limit, still naming the directory', async () => {
  await Bun.write(join(dir, 'a/b/c/deep.ts'), 'x');

  const shallow = await run(listDirTool, { depth: 1 });
  expect(shallow).toContain('a/');
  expect(shallow).not.toContain('deep.ts');

  expect(await run(listDirTool, { depth: 4 })).toContain('deep.ts');
});

test('list_dir honours .gitignore and includeIgnored', async () => {
  await Bun.write(join(dir, '.gitignore'), 'dist/\n');
  await Bun.write(join(dir, 'dist/bundle.js'), 'x');
  await Bun.write(join(dir, 'src/app.ts'), 'x');

  expect(await run(listDirTool, {})).not.toContain('bundle.js');
  expect(await run(listDirTool, { includeIgnored: true })).toContain('bundle.js');
});

test('list_dir scopes to a subdirectory and refuses a file', async () => {
  await Bun.write(join(dir, 'src/app.ts'), 'x');
  await Bun.write(join(dir, 'other.ts'), 'x');

  const out = await run(listDirTool, { path: 'src' });
  expect(out).toContain('app.ts');
  expect(out).not.toContain('other.ts');

  expect(run(listDirTool, { path: 'other.ts' })).rejects.toThrow(/Not a directory/);
});

const PATCH_ADD = `*** Add File: src/new.ts
+export const a = 1;
+export const b = 2;`;

test('parsePatch reads add, update, move, and delete markers', () => {
  const ops = parsePatch(`${PATCH_ADD}
*** Update File: src/old.ts
*** Move to: src/renamed.ts
-const port = 8080;
+const port = 9090;
*** Delete File: src/gone.ts`);

  expect(ops).toEqual([
    { kind: 'add', path: 'src/new.ts', content: 'export const a = 1;\nexport const b = 2;' },
    {
      kind: 'update',
      path: 'src/old.ts',
      moveTo: 'src/renamed.ts',
      oldString: 'const port = 8080;',
      newString: 'const port = 9090;',
    },
    { kind: 'delete', path: 'src/gone.ts' },
  ]);
});

test('parsePatch rejects a malformed envelope rather than guessing', () => {
  expect(() => parsePatch('')).toThrow(/empty/);
  expect(() => parsePatch('just some text')).toThrow(/not a marker/);
  expect(() => parsePatch('*** Update File: a.ts\n+only additions')).toThrow(/at least one - line/);
  expect(() => parsePatch('*** Add File: a.ts\n-removing')).toThrow(/cannot remove lines/);
  expect(() => parsePatch('*** Add File: a.ts\n*** Move to: b.ts\n+x')).toThrow(/only valid on an Update/);
  expect(() => parsePatch('*** Update File: a.ts\nno prefix here')).toThrow(/neither \+ nor -/);
});

test('apply_patch adds, updates, moves, and deletes in one call', async () => {
  await Bun.write(join(dir, 'old.ts'), 'const port = 8080;\n');
  await Bun.write(join(dir, 'gone.ts'), 'obsolete\n');
  await Bun.write(join(dir, 'moving.ts'), 'const name = "a";\n');

  const out = await run(applyPatchTool, {
    patch: `*** Add File: fresh.ts
+export const fresh = true;
*** Update File: old.ts
-const port = 8080;
+const port = 9090;
*** Update File: moving.ts
*** Move to: moved.ts
-const name = "a";
+const name = "b";
*** Delete File: gone.ts`,
  });

  expect(out).toContain('4 changes');
  expect(await Bun.file(join(dir, 'fresh.ts')).text()).toBe('export const fresh = true;\n');
  expect(await Bun.file(join(dir, 'old.ts')).text()).toBe('const port = 9090;\n');
  expect(await Bun.file(join(dir, 'moved.ts')).text()).toBe('const name = "b";\n');
  expect(await Bun.file(join(dir, 'moving.ts')).exists()).toBe(false);
  expect(await Bun.file(join(dir, 'gone.ts')).exists()).toBe(false);
});

test('a patch that fails on its third file writes nothing at all', async () => {
  await Bun.write(join(dir, 'one.ts'), 'const a = 1;\n');
  await Bun.write(join(dir, 'two.ts'), 'const b = 2;\n');

  expect(
    run(applyPatchTool, {
      patch: `*** Update File: one.ts
-const a = 1;
+const a = 10;
*** Update File: two.ts
-const b = 2;
+const b = 20;
*** Update File: three.ts
-const c = 3;
+const c = 30;`,
    }),
  ).rejects.toThrow(/no such file/);

  await Bun.sleep(20);
  // Atomicity is the whole reason this tool exists rather than three edit_file
  // calls, so the first two files must be untouched.
  expect(await Bun.file(join(dir, 'one.ts')).text()).toBe('const a = 1;\n');
  expect(await Bun.file(join(dir, 'two.ts')).text()).toBe('const b = 2;\n');
});

test('apply_patch refuses an ambiguous match without writing', async () => {
  await Bun.write(join(dir, 'dup.ts'), 'x\nx\n');
  expect(run(applyPatchTool, { patch: '*** Update File: dup.ts\n-x\n+y' })).rejects.toThrow(/appear 2 times/);
  await Bun.sleep(20);
  expect(await Bun.file(join(dir, 'dup.ts')).text()).toBe('x\nx\n');
});

test('apply_patch refuses to add over an existing file', async () => {
  await Bun.write(join(dir, 'here.ts'), 'original\n');
  expect(run(applyPatchTool, { patch: '*** Add File: here.ts\n+replacement' })).rejects.toThrow(/already exists/);
  await Bun.sleep(20);
  expect(await Bun.file(join(dir, 'here.ts')).text()).toBe('original\n');
});

test('apply_patch refuses to move onto an existing file', async () => {
  await Bun.write(join(dir, 'from.ts'), 'const a = 1;\n');
  await Bun.write(join(dir, 'to.ts'), 'occupied\n');

  expect(
    run(applyPatchTool, { patch: '*** Update File: from.ts\n*** Move to: to.ts\n-const a = 1;\n+const a = 2;' }),
  ).rejects.toThrow(/already exists/);
  await Bun.sleep(20);
  expect(await Bun.file(join(dir, 'from.ts')).text()).toBe('const a = 1;\n');
  expect(await Bun.file(join(dir, 'to.ts')).text()).toBe('occupied\n');
});

test('apply_patch refuses the same file twice in one patch', async () => {
  await Bun.write(join(dir, 'twice.ts'), 'a\nb\n');
  expect(
    run(applyPatchTool, { patch: '*** Update File: twice.ts\n-a\n+A\n*** Update File: twice.ts\n-b\n+B' }),
  ).rejects.toThrow(/appears twice/);
});

test('apply_patch refuses a path outside the workspace', async () => {
  expect(run(applyPatchTool, { patch: '*** Add File: ../escape.ts\n+x' })).rejects.toThrow(/escapes workspace/);
});

test('an update that removes lines and adds none deletes them', async () => {
  await Bun.write(join(dir, 'trim.ts'), 'keep\nremove me\nkeep too\n');
  await run(applyPatchTool, { patch: '*** Update File: trim.ts\n-remove me\n' });
  expect(await Bun.file(join(dir, 'trim.ts')).text()).toBe('keep\n\nkeep too\n');
});

test('glob skips gitignored paths and honours includeIgnored', async () => {
  await Bun.write(join(dir, '.gitignore'), 'dist/\n');
  await Bun.write(join(dir, 'dist/app.js'), 'x');
  await Bun.write(join(dir, 'src/app.js'), 'x');

  expect(await run(globTool, { pattern: '**/*.js' })).toBe('src/app.js');
  const both = await run(globTool, { pattern: '**/*.js', includeIgnored: true });
  expect(both.split('\n').sort()).toEqual(['dist/app.js', 'src/app.js']);
});

test('grep skips gitignored paths and honours includeIgnored', async () => {
  await Bun.write(join(dir, '.gitignore'), 'vendor/\n');
  await Bun.write(join(dir, 'vendor/lib.ts'), 'const needle = 1;\n');
  await Bun.write(join(dir, 'src/own.ts'), 'const needle = 2;\n');

  const clean = await run(grepTool, { pattern: 'needle' });
  expect(clean).toContain('src/own.ts');
  expect(clean).not.toContain('vendor/lib.ts');

  const all = await run(grepTool, { pattern: 'needle', includeIgnored: true });
  expect(all).toContain('vendor/lib.ts');
});

test('grep skips binaries', async () => {
  await Bun.write(join(dir, 'blob.bin'), new Uint8Array([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  await Bun.write(join(dir, 'code.ts'), 'needle\n');
  const out = await run(grepTool, { pattern: 'needle' });
  expect(out).toContain('code.ts');
  expect(out).not.toContain('blob.bin');
});

test('grep honours ignoreCase', async () => {
  await Bun.write(join(dir, 'c.ts'), 'NEEDLE\n');
  expect(await run(grepTool, { pattern: 'needle' })).toBe('No matches.');
  expect(await run(grepTool, { pattern: 'needle', ignoreCase: true })).toContain('c.ts:1: NEEDLE');
});

test('grep reports no matches rather than an empty string', async () => {
  await Bun.write(join(dir, 'a.ts'), 'nothing here\n');
  expect(await run(grepTool, { pattern: 'zzzznope' })).toBe('No matches.');
});

test('grep rejects an invalid regex instead of crashing the loop', async () => {
  await Bun.write(join(dir, 'a.ts'), 'x\n');
  expect(run(grepTool, { pattern: '([' })).rejects.toThrow(/Invalid regex/);
});

test('bash returns the exit code and captured output', async () => {
  const out = await run(bashTool, { command: 'echo hello' });
  expect(out).toContain('exit: 0');
  expect(out).toContain('hello');
});

test('bash reports a non-zero exit code', async () => {
  const out = await run(bashTool, { command: 'exit 3' });
  expect(out).toContain('exit: 3');
});

test('bash streams output to the listener before the command exits', async () => {
  const chunks: { id: string; text: string }[] = [];
  onBashOutput(({ toolCallId, chunk }) => chunks.push({ id: toolCallId, text: chunk }));

  const script =
    process.platform === 'win32'
      ? // Unconditional sequencing: a blocked loopback makes `ping` exit 1, and `&&`
        // would then skip `echo second` on machines where ICMP is filtered.
        'echo first & ping -n 2 127.0.0.1 > nul & echo second'
      : 'echo first; sleep 0.4; echo second';
  await run(bashTool, { command: script });

  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((c) => c.id === 't1')).toBe(true);
  const streamed = chunks.map((c) => c.text).join('');
  expect(streamed).toContain('first');
  expect(streamed).toContain('second');
}, 20_000);

test('the bash listener is cleared when unset', async () => {
  const chunks: string[] = [];
  onBashOutput(({ chunk }) => chunks.push(chunk));
  await run(bashTool, { command: 'echo one' });
  const afterFirst = chunks.length;

  onBashOutput(undefined);
  await run(bashTool, { command: 'echo two' });
  expect(chunks.length).toBe(afterFirst);
}, 20_000);

const sleeper = process.platform === 'win32' ? 'ping -n 20 127.0.0.1 > nul' : 'sleep 20';

test('interruptBash kills the command in flight and names it', async () => {
  const started = Date.now();
  const call = run(bashTool, { command: sleeper, timeout: 30_000 });

  await Bun.sleep(400);
  expect(interruptBash()).toEqual([sleeper]);

  expect(call).rejects.toThrow(/user interrupted this command/i);
  await call.catch(() => {});
  // Killed, not waited out: the 20s command must not have run to completion.
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);

test('the interrupt error carries whatever the command printed first', async () => {
  const script =
    process.platform === 'win32' ? 'echo before && ping -n 20 127.0.0.1 > nul' : 'echo before; sleep 20';
  const call = run(bashTool, { command: script, timeout: 30_000 });

  await Bun.sleep(600);
  interruptBash();

  const message = await call.then(() => '', (e: Error) => e.message);
  expect(message).toContain('before');
  expect(message).toContain('effects are unknown');
}, 30_000);

test('interruptBash with nothing running is a no-op', () => {
  expect(interruptBash()).toEqual([]);
});

test('a command that finished is no longer interruptible', async () => {
  await run(bashTool, { command: 'echo done' });
  expect(interruptBash()).toEqual([]);
}, 20_000);
