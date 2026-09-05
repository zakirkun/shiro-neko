import { expect, test } from 'bun:test';
import { farewell } from '../src/farewell';

const record = { id: '0193ab2c-7f31-4c9a-b8e1-6d2f9a4c1e58', messages: 8, title: 'why does the pagination test fail?' };

test('a saved session says good bye and both ways to resume it', () => {
  const text = farewell(record);

  expect(text).toContain('Good bye');
  // The short prefix is what a user retypes, so it is what gets shown.
  expect(text).toContain('shiro -c');
  expect(text).toContain('shiro -r 0193ab2c');
  expect(text).not.toContain(record.id);
});

test('the session is identified by its title, so the right one is recognisable', () => {
  expect(farewell(record)).toContain('why does the pagination test fail?');
  expect(farewell({ ...record, messages: 8 })).toContain('8 messages');
});

test('a single message reads as one message', () => {
  expect(farewell({ ...record, messages: 1 })).toContain('1 message');
  expect(farewell({ ...record, messages: 1 })).not.toContain('1 messages');
});

test('an empty session promises no resume command that would fail', () => {
  // Nothing is persisted when no message was exchanged, so `-c` would find
  // nothing: claiming otherwise sends the user to an error.
  const text = farewell({ ...record, messages: 0 });

  expect(text).toContain('Good bye');
  expect(text).not.toContain('shiro -c');
  expect(text).not.toContain('-r ');
});

test('a long title is cut rather than wrapped across the farewell', () => {
  const text = farewell({ ...record, title: 'x'.repeat(200) });
  for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
});

test('an untitled session still resumes, without an empty quote', () => {
  const text = farewell({ ...record, title: 'untitled' });
  expect(text).toContain('shiro -c');
  expect(text).not.toContain('""');
});
