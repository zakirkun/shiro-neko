import { Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

export type PromptInputProps = {
  value: string;
  /** Cursor is reported alongside the value: `@path` completion needs to know where it is. */
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  /** Newest-last list of previously submitted prompts, walked by up/down. */
  history?: readonly string[];
  /** Intercept a key before the input consumes it. Return true to swallow it. */
  onKey?: (input: string, key: KeyLike) => boolean;
  /** Where to put the cursor on mount, for a remounted input after a completion. */
  initialCursor?: number;
};

type KeyLike = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
  meta: boolean;
  home?: boolean;
  end?: boolean;
};

const INVERSE_ON = '\u001B[7m';
const INVERSE_OFF = '\u001B[27m';
const invert = (s: string) => `${INVERSE_ON}${s}${INVERSE_OFF}`;

/**
 * Text input with a real cursor and shell-style history recall.
 *
 * ink-text-input cannot do this: it discards up/down before its own handler and
 * only ever shrinks its internal cursor offset, so an externally driven value
 * leaves the cursor stranded. Owning the cursor here also gives us home/end and
 * ctrl-a/e/k/u/w for free.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
  mask,
  history = [],
  onKey,
  initialCursor,
}: PromptInputProps) {
  const [cursor, setCursor] = useState(initialCursor ?? value.length);
  // -1 means "editing a fresh line"; 0+ indexes back from the newest entry.
  const [recall, setRecall] = useState(-1);
  const [stash, setStash] = useState('');

  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  const set = (next: string, nextCursor = next.length) => {
    const clamped = Math.max(0, Math.min(nextCursor, next.length));
    onChange(next, clamped);
    setCursor(clamped);
  };

  /** Position after the next run of spaces, i.e. the start of the following word. */
  const wordForward = (from: number) => {
    let at = from;
    while (at < value.length && value[at] === ' ') at++;
    while (at < value.length && value[at] !== ' ') at++;
    return at;
  };

  /** Position before the run of spaces preceding the current word. */
  const wordBack = (from: number) => {
    let at = from;
    while (at > 0 && value[at - 1] === ' ') at--;
    while (at > 0 && value[at - 1] !== ' ') at--;
    return at;
  };

  useInput(
    (input, key) => {
      if (onKey?.(input, key as KeyLike)) return;

      if (key.return) {
        setRecall(-1);
        setStash('');
        setCursor(0);
        onSubmit(value);
        return;
      }

      if (key.upArrow || key.downArrow) {
        if (history.length === 0) return;
        if (key.upArrow) {
          const next = Math.min(recall + 1, history.length - 1);
          if (recall === -1) setStash(value);
          setRecall(next);
          set(history[history.length - 1 - next] ?? value);
        } else {
          const next = recall - 1;
          setRecall(next);
          set(next < 0 ? stash : (history[history.length - 1 - next] ?? ''));
        }
        return;
      }

      // Word-wise motion. Terminals send ctrl-left/right as a modified arrow, but
      // Ink reports some of these sequences as a plain input with ctrl held rather
      // than as key.leftArrow, so both shapes are handled.
      const wordLeft = key.leftArrow && (key.ctrl || key.meta);
      const wordRight = key.rightArrow && (key.ctrl || key.meta);
      if (wordLeft) return setCursor((c) => wordBack(c));
      if (wordRight) return setCursor((c) => wordForward(c));

      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.home || (key.ctrl && input === 'a')) return setCursor(0);
      if (key.end || (key.ctrl && input === 'e')) return setCursor(value.length);

      if (key.ctrl && input === 'k') return set(value.slice(0, cursor), cursor);
      if (key.ctrl && input === 'u') return set(value.slice(cursor), 0);
      // The delete key's forward cousin: without it, fixing a typo ahead of the
      // cursor means walking to the end or backspacing and retyping the tail.
      if (key.ctrl && input === 'd') return set(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      if (key.ctrl && input === 'w') {
        const upto = value.slice(0, cursor);
        const trimmed = upto.replace(/\S+\s*$/, '');
        return set(trimmed + value.slice(cursor), trimmed.length);
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }

      // Ignore remaining control sequences; a paste arrives as one multi-char input.
      if (!input || key.tab || key.escape || key.meta || key.ctrl) return;
      set(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
    },
    { isActive: focus },
  );

  if (value.length === 0) {
    if (!placeholder) return <Text>{focus ? invert(' ') : ' '}</Text>;
    return (
      <Text dimColor>
        {focus ? invert(placeholder.slice(0, 1)) : placeholder.slice(0, 1)}
        {placeholder.slice(1)}
      </Text>
    );
  }

  const shown = mask ? mask.repeat(value.length) : value;
  if (!focus) return <Text>{shown}</Text>;

  return (
    <Text>
      {shown.slice(0, cursor)}
      {invert(shown.slice(cursor, cursor + 1) || ' ')}
      {shown.slice(cursor + 1)}
    </Text>
  );
}

export type { KeyLike };
