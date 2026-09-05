import { Box, Text, useInput } from 'ink';
import React from 'react';
import type { ApprovalDecision, ApprovalRequest } from '../session';
import { Diff } from './Diff';
import { toolDetail } from './transcript';

export type Pending = { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void };

/** Bridges Session's promise-based approval callback into React state. */
export type ApprovalBridge = {
  bind: (fn: (p: Pending | undefined) => void) => void;
  ask: (req: ApprovalRequest) => Promise<ApprovalDecision>;
};

export function createApprovalBridge(): ApprovalBridge {
  let setter: ((p: Pending | undefined) => void) | undefined;
  return {
    bind(fn) {
      setter = fn;
    },
    ask(req) {
      return new Promise((resolve) => {
        if (!setter) return resolve('deny'); // UI not mounted: fail closed
        setter({
          req,
          resolve: (d) => {
            setter?.(undefined);
            resolve(d);
          },
        });
      });
    },
  };
}

/**
 * What the call is about to do, in the shape that decision needs.
 *
 * An edit gets a coloured diff, because the question is which lines change. Every
 * other tool gets the same argument lines the transcript shows, which is both
 * consistent and far more readable than a JSON dump of the input.
 */
function ApprovalDetail({ name, input }: { name: string; input: unknown }) {
  const o = (input ?? {}) as Record<string, unknown>;

  if (name === 'write_file') {
    const content = String(o['content'] ?? '');
    return <Diff before="" after={content} path={`${String(o['path'])} (new content)`} />;
  }
  if (name === 'edit_file') {
    return <Diff before={String(o['oldString'] ?? '')} after={String(o['newString'] ?? '')} path={String(o['path'])} />;
  }

  const detail = toolDetail(name, input);
  if (detail.length === 0) return <Text dimColor>{JSON.stringify(input)}</Text>;
  return (
    <Box flexDirection="column">
      {detail.slice(0, 10).map((d, i) => (
        <Text key={i} dimColor>
          {`  ${d}`}
        </Text>
      ))}
      {detail.length > 10 && <Text dimColor>{`  ... ${detail.length - 10} more`}</Text>}
    </Box>
  );
}

/** Why this call stopped, in the words that make the decision obvious. */
function reason(req: ApprovalRequest): string {
  if (req.repeated) return `${req.toolName} is repeating the same call`;
  if (req.subagent) return `a worker subagent wants to run ${req.toolName}`;
  return `${req.toolName} wants to run`;
}

export function Approval({ pending }: { pending: Pending }) {
  const { req } = pending;

  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === 'y' || key.return) pending.resolve('once');
    else if (c === 'a') pending.resolve('always');
    else if (c === 'n' || key.escape) pending.resolve('deny');
  });

  const grant = req.suggestedPattern === '*' ? req.toolName : `${req.toolName} ${req.suggestedPattern}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        {reason(req)}
      </Text>
      {req.repeated && <Text dimColor>allowed by the rules, but this is the third identical call this turn</Text>}
      {req.subagent && !req.repeated && (
        <Text dimColor>delegated work, gated by your rules exactly as a direct call is</Text>
      )}
      {!req.repeated && req.matchedPattern && req.matchedPattern !== '*' && (
        <Text dimColor>{`matched ${req.toolName}: "${req.matchedPattern}"`}</Text>
      )}
      <ApprovalDetail name={req.toolName} input={req.input} />
      <Text>
        <Text color="green">y</Text> allow once | <Text color="green">a</Text> always allow {grant} |{' '}
        <Text color="red">n</Text> deny
      </Text>
    </Box>
  );
}
