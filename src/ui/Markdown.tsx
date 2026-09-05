import { Box, Text } from 'ink';
import React from 'react';
import { parseInline, parseMarkdown, type Block, type Span } from '../markdown';

const HEADING_COLOR = ['cyan', 'cyan', 'blue', 'blue', 'gray', 'gray'] as const;

function Inline({ spans }: { spans: Span[] }) {
  return (
    <Text>
      {spans.map((s, i) => (
        <Text
          key={i}
          bold={s.bold}
          italic={s.italic}
          strikethrough={s.strike}
          underline={s.link}
          color={s.code ? 'yellow' : s.link ? 'blue' : undefined}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

function CodeBlock({ language, lines }: { language: string; lines: string[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {language.length > 0 && <Text dimColor>{language}</Text>}
      {lines.map((l, i) => (
        <Text key={i} color="green">
          {l.length > 0 ? l : ' '}
        </Text>
      ))}
    </Box>
  );
}

function BlockView({ block, width }: { block: Block; width: number }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Box marginTop={block.level === 1 ? 1 : 0}>
          <Text bold color={HEADING_COLOR[block.level - 1] ?? 'gray'}>
            <Inline spans={block.spans} />
          </Text>
        </Box>
      );
    case 'paragraph':
      return <Inline spans={block.spans} />;
    case 'bullet': {
      // A markdown task list: `- [x] done`. The checkbox is the marker, and the
      // text of a done task reads as already read — dimmed and struck through,
      // the same treatment the todo panel gives a finished entry.
      const task = /^\[( |x)\]\s+(.*)$/.exec(block.spans.map((s) => s.text).join(''));
      if (task) {
        const done = task[1] === 'x';
        return (
          <Box>
            <Text dimColor>{`${'  '.repeat(block.indent)}${done ? '[x]' : '[ ]'} `}</Text>
            <Text strikethrough={done} dimColor={done}>
              <Inline spans={parseInline(task[2]!)} />
            </Text>
          </Box>
        );
      }
      return (
        <Box>
          <Text dimColor>{`${'  '.repeat(block.indent)}${block.marker} `}</Text>
          <Box flexGrow={1}>
            <Inline spans={block.spans} />
          </Box>
        </Box>
      );
    }
    case 'quote':
      return (
        <Box>
          <Text color="gray">{'| '}</Text>
          <Text dimColor italic>
            <Inline spans={block.spans} />
          </Text>
        </Box>
      );
    case 'code':
      return <CodeBlock language={block.language} lines={block.lines} />;
    case 'rule':
      return <Text dimColor>{'-'.repeat(Math.max(4, Math.min(width, 60)))}</Text>;
    case 'blank':
      return <Text> </Text>;
  }
}

/**
 * Renders agent output as styled terminal markdown.
 *
 * Parsing happens here rather than in the transcript because a partial stream is
 * re-parsed on every flush; an unclosed fence simply renders as a code block that
 * grows, which is what a reader expects while text is still arriving.
 */
export function Markdown({ text, width = 80 }: { text: string; width?: number }) {
  const blocks = parseMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} width={width} />
      ))}
    </Box>
  );
}

/** One line of inline-styled markdown, for labels and summaries. */
export function InlineMarkdown({ text }: { text: string }) {
  return <Inline spans={parseInline(text)} />;
}
