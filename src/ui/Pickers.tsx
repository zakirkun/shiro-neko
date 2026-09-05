import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import React from 'react';
import type { CommandSpec } from '../commands';
import { InstallPrompt, type RegistryRow } from './Panels';

/** The `/` menu, narrowing as the name is typed. */
export function CommandMenu({ matches, index }: { matches: readonly CommandSpec[]; index: number }) {
  const width = Math.max(...matches.map((c) => `/${c.name}${c.arg ? ` ${c.arg}` : ''}`.length)) + 1;
  return (
    <Box flexDirection="column" marginTop={1}>
      {matches.map((c, i) => (
        <Box key={c.name}>
          <Text color={i === index ? 'cyan' : undefined}>{i === index ? '> ' : '  '}</Text>
          <Text color={i === index ? 'cyan' : undefined} bold={i === index}>
            {`/${c.name}${c.arg ? ` ${c.arg}` : ''}`.padEnd(width)}
          </Text>
          <Text dimColor>{c.summary}</Text>
        </Box>
      ))}
      <Text dimColor>up/down move | tab complete | enter run | esc dismiss</Text>
    </Box>
  );
}

/** Keyboard wrapper around InstallPrompt, so the prompt itself stays presentational. */
export function InstallConfirm({
  staged,
  onDone,
}: {
  staged: { row: RegistryRow; url: string; preview: string };
  onDone: (yes: boolean) => void;
}) {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === 'y' || key.return) onDone(true);
    else if (c === 'n' || key.escape) onDone(false);
  });

  return <InstallPrompt name={staged.row.name} kind={staged.row.kind} url={staged.url} preview={staged.preview} />;
}

export type PickerOption = { value: string; label: string };

/**
 * The bordered frame every wizard and picker sits in.
 *
 * It lived as two private copies, one in Onboard and one in McpAdd, which had
 * already drifted: one took an `error` line and the other did not. One component
 * means the border, title, hint, and error treatment stay the same everywhere.
 */
export function Frame({
  title,
  hint,
  error,
  warning,
  children,
}: {
  title: string;
  hint?: string;
  error?: string;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {title}
      </Text>
      {hint && <Text dimColor>{hint}</Text>}
      {warning && <Text color="yellow">could not list models: {warning}</Text>}
      {error && <Text color="red">{error}</Text>}
      {children}
    </Box>
  );
}

/** A `label:` prefix in the frame's colour, for one input line of a form. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text color="cyan">{label}: </Text>
      {children}
    </Box>
  );
}

/**
 * One bordered list picker, shared by the model, agent, and thinking choosers.
 *
 * They were three copies of the same twenty lines differing only in title, hint,
 * and items. One component means a change to the picker's behaviour — the escape
 * hint, the highlight, the row limit — lands in all three at once.
 */
export function Picker({
  title,
  hint,
  options,
  current,
  limit = 10,
  onSelect,
}: {
  title: string;
  hint?: string;
  options: readonly PickerOption[];
  /** Value to start on, so a picker opens at what is already in use. */
  current?: string;
  limit?: number;
  onSelect: (value: string) => void;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {title}
      </Text>
      <Text dimColor>{hint ? `${hint} - enter to select, esc to cancel` : 'enter to select, esc to cancel'}</Text>
      <SelectInput
        items={options.map((o) => ({ key: o.value, label: o.label, value: o.value }))}
        limit={limit}
        initialIndex={Math.max(
          0,
          options.findIndex((o) => o.value === current),
        )}
        onSelect={(item) => onSelect(item.value)}
      />
    </Box>
  );
}
