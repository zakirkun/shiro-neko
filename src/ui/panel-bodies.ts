import { costOf, formatUsd } from '../pricing';
import type { Session } from '../session';
import { toolSetOf } from '../tools';
import { todoLines } from './transcript';

export type Panel = { title: string; hint?: string; body: string };

/**
 * The read-only panel bodies, as pure functions of session and hook state.
 *
 * These were inline inside App's submit switch, where each one added a `setPanel`
 * call wrapped around string assembly and pushed the switch past the point a reader
 * can follow it. Out here they are testable without mounting Ink, and the switch
 * reads as routing rather than as formatting.
 */

export function toolsPanel(session: Session): Panel {
  const offered = session.activeTools().sort();
  return {
    title: 'tools',
    hint: `${offered.length} offered this turn of ${Object.keys(session.tools).length} registered`,
    body: offered
      .map((t) => {
        const set = toolSetOf(t);
        return `- \`${t}\`${set ? `  ${set}` : ''}`;
      })
      .join('\n'),
  };
}

export function costPanel(
  session: Session,
  info: { sessionId: string; model: string; agent: string; thinking: string },
): Panel {
  const spend = costOf(info.model, session.inputTokens, session.outputTokens);
  return {
    title: 'cost',
    hint: `session ${info.sessionId}`,
    body: [
      `- model: \`${info.model}\``,
      `- billed: ${session.inputTokens} in / ${session.outputTokens} out`,
      `- spend: ${spend === undefined ? 'unpriced model' : formatUsd(spend)}`,
      `- context: ~${session.estimatedTokens()} tokens`,
      `- agent: \`${info.agent}\` thinking \`${info.thinking}\``,
    ].join('\n'),
  };
}

export function contextPanel(files: readonly string[]): Panel {
  return {
    title: 'project instructions',
    body:
      files.length > 0
        ? files.map((f) => `- \`${f}\``).join('\n')
        : 'No `AGENTS.md`, `CLAUDE.md`, or `.shiro.md` found. Run `/init` to write one.',
  };
}

export const todosPanel = (session: Session): Panel => ({
  title: 'task list',
  body: todoLines(session.notebook.state().todos),
});
