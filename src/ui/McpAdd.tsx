import { Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useCallback, useState } from 'react';
import type { McpServerConfig } from '../mcp';
import { Frame as Panel, Row } from './Pickers';

/** The shared frame plus the cancel hint every step of this wizard carries. */
function Frame({ children, ...rest }: React.ComponentProps<typeof Panel>) {
  return (
    <Panel {...rest}>
      {children}
      <Text dimColor>esc to cancel</Text>
    </Panel>
  );
}

export type McpAddResult = { name: string; config: McpServerConfig };

type Kind = 'local' | 'remote';

type Step =
  | { name: 'pick-kind' }
  | { name: 'server-name'; kind: Kind }
  | { name: 'command'; server: string }
  | { name: 'args'; server: string; command: string }
  | { name: 'url'; server: string }
  | { name: 'headers'; server: string; url: string };

/**
 * A server name has to survive being spliced into a tool name.
 *
 * Tools are registered as `mcp__<server>__<tool>`, so a name containing `__` or a
 * space produces a tool the model cannot reliably call and two servers whose
 * namespaces can collide. Rejecting it here beats a confusing failure at connect.
 */
export function invalidName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'a name is required';
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(trimmed)) return 'use letters, digits, and hyphens only';
  if (trimmed.includes('__')) return 'double underscores clash with the mcp__server__tool naming';
  return undefined;
}

/** `KEY: value, OTHER: value` into a header object. Empty input means no headers. */
export function parseHeaders(raw: string): Record<string, string> | undefined {
  const pairs = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(':');
      return at === -1 ? undefined : ([part.slice(0, at).trim(), part.slice(at + 1).trim()] as const);
    })
    .filter((p): p is readonly [string, string] => p !== undefined && p[0].length > 0);

  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

/** Splits a command line on spaces, keeping quoted runs together. */
export function splitArgs(raw: string): string[] {
  const matched = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matched.map((a) => a.replace(/^["']|["']$/g, ''));
}

/**
 * Adds one MCP server, local or remote, without hand-editing config.json.
 *
 * The two kinds need different fields — a command and its arguments against a URL
 * and its headers — so the wizard branches rather than showing a form with half of
 * it inapplicable. It collects and returns; writing the config is the caller's.
 */
export function McpAdd({
  existing,
  onDone,
  onCancel,
}: {
  existing: string[];
  onDone: (result: McpAddResult) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>({ name: 'pick-kind' });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const advance = useCallback((next: Step) => {
    setDraft('');
    setError(undefined);
    setStep(next);
  }, []);

  const submitName = useCallback(
    (kind: Kind, value: string) => {
      const bad = invalidName(value);
      if (bad) return setError(bad);
      const server = value.trim();
      if (existing.includes(server)) return setError(`${server} is already configured`);
      advance(kind === 'local' ? { name: 'command', server } : { name: 'url', server });
    },
    [advance, existing],
  );

  switch (step.name) {
    case 'pick-kind':
      return (
        <Frame
          title="Add an MCP server"
          hint={existing.length > 0 ? `${existing.length} configured: ${existing.join(', ')}` : 'none configured yet'}
        >
          <SelectInput
            items={[
              { key: 'local', label: 'local    a command on this machine, over stdio', value: 'local' },
              { key: 'remote', label: 'remote   an http or sse endpoint', value: 'remote' },
            ]}
            onSelect={(item) => advance({ name: 'server-name', kind: item.value as Kind })}
          />
        </Frame>
      );

    case 'server-name':
      return (
        <Frame
          title={`${step.kind === 'local' ? 'Local' : 'Remote'} server: name`}
          hint="used in the tool name as mcp__<name>__<tool>"
          error={error}
        >
          <Row label="name">
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => submitName(step.kind, v)}
              placeholder="filesystem"
            />
          </Row>
        </Frame>
      );

    case 'command':
      return (
        <Frame title={`${step.server}: command`} hint="the executable to run, e.g. npx or bun" error={error}>
          <Row label="command">
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) =>
                v.trim() ? advance({ name: 'args', server: step.server, command: v.trim() }) : setError('a command is required')
              }
              placeholder="npx"
            />
          </Row>
        </Frame>
      );

    case 'args':
      return (
        <Frame
          title={`${step.server}: arguments`}
          hint={`${step.command} <args> - enter with nothing to pass none`}
        >
          <Row label="args">
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => {
                const args = splitArgs(v.trim());
                onDone({
                  name: step.server,
                  config: { command: step.command, ...(args.length > 0 ? { args } : {}) },
                });
              }}
              placeholder="-y @modelcontextprotocol/server-filesystem ."
            />
          </Row>
        </Frame>
      );

    case 'url':
      return (
        <Frame title={`${step.server}: endpoint URL`} hint="http or https, the server's MCP endpoint" error={error}>
          <Row label="url">
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => {
                const url = v.trim();
                if (!/^https?:\/\//i.test(url)) return setError('the URL must start with http:// or https://');
                advance({ name: 'headers', server: step.server, url });
              }}
              placeholder="https://example.com/mcp"
            />
          </Row>
        </Frame>
      );

    case 'headers':
      return (
        <Frame
          title={`${step.server}: headers`}
          hint="KEY: value, comma separated - enter with nothing for none"
        >
          <Row label="headers">
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => {
                const headers = parseHeaders(v);
                onDone({
                  name: step.server,
                  config: { url: step.url, ...(headers ? { headers } : {}) },
                });
              }}
              placeholder="Authorization: Bearer sk-..."
            />
          </Row>
        </Frame>
      );
  }
}
