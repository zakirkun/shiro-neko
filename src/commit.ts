import { tool, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { git } from './tools-git';

/** Recent subjects shown to the model, so the message matches the repository's style. */
const SUBJECTS = 15;
/** The staged diff is the bulk of the call; beyond this it is cut with a note. */
const MAX_DIFF = 24_000;

export const COMMIT_TOOL_NAME = 'git_commit_message';

/** A reply's wrapping — fenced blocks, surrounding prose, leading/trailing quotes. */
const unwrap = (reply: string): string => {
  const fenced = /```[a-z]*\n([\s\S]*?)```/i.exec(reply);
  const body = fenced ? fenced[1]! : reply;
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().replace(/^["'`]|["'`]$/g, '').slice(0, 72);
};

/**
 * Generates a commit message from the staged changes with one nested model call.
 *
 * The model sees two things: the staged diff, and the repository's own recent
 * subjects, because a message that ignores the established style reads as foreign
 * no matter how accurate it is. The subject style of this repository — plain
 * imperative, no conventional-commit prefix — is one example; the sample keeps
 * the choice local to whatever the history actually says.
 *
 * It never commits. Generating the message is safe to auto-approve; running the
 * commit is not, and that stays on the gated `bash` path where the user sees the
 * message and the command together.
 */
export function createCommitMessageTool(opts: { model: LanguageModel; cwd?: string }) {
  return tool({
    description:
      'Generate a commit message from the staged changes, in one nested model call. Reads the ' +
      'staged diff and the recent commit subjects so the message matches the repository\'s style. ' +
      'It does not commit — it returns the message only. Use git_diff first to see what is staged, ' +
      'and run the commit through bash where the user approves it.',
    inputSchema: z.object({}),
    execute: async () => {
      const cwd = opts.cwd ?? process.cwd();

      const staged = await git(['diff', '--staged', '--no-color'], cwd);
      if (!staged.ok) throw new Error(staged.message);
      const diff = staged.stdout.trim();
      if (diff.length === 0) return 'Nothing is staged. Stage the change first, then ask again.';

      const subjects = await git(
        ['log', `-n${SUBJECTS}`, '--pretty=format:%s'],
        cwd,
      );
      const history = subjects.ok && subjects.stdout.trim().length > 0 ? subjects.stdout : '(no commits yet)';

      const shown =
        diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n... [truncated ${diff.length - MAX_DIFF} chars]` : diff;

      const { text } = await generateText({
        model: opts.model,
        system:
          'You write one commit message for the staged diff below. Match the subject style of the ' +
          'recent commits listed after it: same language, same capitalisation, same prefix convention ' +
          'or lack of one. One line, no body, no quotes, no backticks, no prefix like "commit:". ' +
          'Describe what the change does, not what files it touches.',
        prompt: `Staged diff:\n\n${shown}\n\nRecent commit subjects:\n${history}`,
        maxRetries: 2,
      });

      const message = unwrap(text);
      if (message.length === 0) throw new Error('the model returned no message; ask again or write one yourself');
      return message;
    },
  });
}
