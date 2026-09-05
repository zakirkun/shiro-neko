import { Box, Text } from 'ink';
import React from 'react';

export type DiffLine = { kind: 'context' | 'add' | 'remove'; text: string; at: number };

/**
 * Line-level diff by longest common subsequence. O(n*m) is fine here because an
 * edit_file payload is a handful of lines, not a whole file.
 *
 * `at` is the 1-based line number in the file the line came from: the reader's copy
 * for a removal, the changed copy for an addition, either for context.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i]!, at: i + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'remove', text: a[i]!, at: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]!, at: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'remove', text: a[i]!, at: i + 1 }), i++;
  while (j < m) out.push({ kind: 'add', text: b[j]!, at: j + 1 }), j++;
  return out;
}

/**
 * Drops runs of unchanged lines longer than `context` on both sides of a change.
 *
 * A gap carries the line range it hides rather than only a count: "27 unchanged
 * lines" says how much was skipped, "lines 1-27" says where in the file the reader
 * is, which is what they actually need when they go and open it.
 */
export function collapseContext(
  lines: DiffLine[],
  context = 2,
): (DiffLine | { kind: 'gap'; count: number; from: number; to: number })[] {
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (line.kind === 'context') return;
    for (let k = i - context; k <= i + context; k++) if (k >= 0 && k < lines.length) keep.add(k);
  });

  const out: (DiffLine | { kind: 'gap'; count: number; from: number; to: number })[] = [];
  let skipped: DiffLine[] = [];
  lines.forEach((line, i) => {
    if (keep.has(i)) {
      if (skipped.length > 0) {
        const first = skipped[0]!;
        const last = skipped.at(-1)!;
        out.push({ kind: 'gap', count: skipped.length, from: first.at, to: last.at });
        skipped = [];
      }
      out.push(line);
    } else {
      skipped.push(line);
    }
  });
  if (skipped.length > 0) {
    const first = skipped[0]!;
    const last = skipped.at(-1)!;
    out.push({ kind: 'gap', count: skipped.length, from: first.at, to: last.at });
  }
  return out;
}

const MAX_RENDERED = 40;

export function Diff({ before, after, path }: { before: string; after: string; path?: string }) {
  const all = collapseContext(diffLines(before, after));
  const shown = all.slice(0, MAX_RENDERED);
  const hidden = all.length - shown.length;
  const added = all.filter((l) => l.kind === 'add').length;
  const removed = all.filter((l) => l.kind === 'remove').length;

  return (
    <Box flexDirection="column">
      {path && (
        <Text>
          <Text bold>{path}</Text> <Text color="green">+{added}</Text> <Text color="red">-{removed}</Text>
        </Text>
      )}
      {shown.map((line, i) =>
        line.kind === 'gap' ? (
          <Text key={i} dimColor>{`   ... lines ${line.from}-${line.to} unchanged`}</Text>
        ) : (
          <Text
            key={i}
            color={line.kind === 'add' ? 'green' : line.kind === 'remove' ? 'red' : undefined}
            dimColor={line.kind === 'context'}
          >{` ${String(line.at).padStart(3)} ${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} ${line.text}`}</Text>
        ),
      )}
      {hidden > 0 && <Text dimColor>{`   ... ${hidden} more diff lines`}</Text>}
    </Box>
  );
}
