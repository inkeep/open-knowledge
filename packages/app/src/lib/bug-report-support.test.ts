/**
 * Unit tests for the pure helpers in the shared bug-report module.
 *
 * `zipBasename` is the load-bearing one: the renderer keys a send operation by
 * it, and Electron main independently keys the same report by `path.basename`
 * of the same zip path. The two derivations have to agree on both separators
 * for a renderer operation to name the report main is actually sending.
 */

import { isBlankNoteContent } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { bugReportNoteTitle, supportMailtoUrl, zipBasename } from './bug-report-support.ts';

describe('zipBasename', () => {
  test('reduces a posix path to the filename', () => {
    expect(zipBasename('/Users/x/Library/ok/reports/ok-report-2026-08-18.zip')).toBe(
      'ok-report-2026-08-18.zip',
    );
  });

  test('reduces a Windows path to the filename', () => {
    expect(zipBasename('C:\\Users\\x\\AppData\\ok\\ok-report-2026-08-18.zip')).toBe(
      'ok-report-2026-08-18.zip',
    );
  });

  test('passes a bare filename through unchanged', () => {
    expect(zipBasename('ok-report-2026-08-18.zip')).toBe('ok-report-2026-08-18.zip');
  });
});

describe('supportMailtoUrl', () => {
  test('addresses support and percent-encodes the subject', () => {
    expect(supportMailtoUrl('Bug report OK-1234 #2')).toBe(
      'mailto:support@inkeep.com?subject=Bug%20report%20OK-1234%20%232',
    );
  });
});

/**
 * One corpus, two jobs: each row is its own named derivation case, and the
 * idempotence test replays the whole set. A case added here is covered by both.
 */
const NOTE_TITLE_CASES: ReadonlyArray<{
  name: string;
  note: string | undefined;
  title: string | undefined;
}> = [
  {
    name: 'titles a single-line note with the line itself',
    note: 'The editor froze after I pasted a large table',
    title: 'The editor froze after I pasted a large table',
  },
  {
    name: 'titles a multi-line note with its first line',
    note: 'Sync hangs on large vaults\nSteps to reproduce:\n1. Open the vault',
    title: 'Sync hangs on large vaults',
  },
  {
    name: 'skips leading blank lines',
    note: '\n\n   \nSync hangs on large vaults',
    title: 'Sync hangs on large vaults',
  },
  {
    name: 'treats a lone carriage return as a line break',
    note: 'Sync hangs on large vaults\rSteps to reproduce:',
    title: 'Sync hangs on large vaults',
  },
  {
    name: 'treats a CRLF pair as one line break',
    note: 'Sync hangs on large vaults\r\nSteps to reproduce:',
    title: 'Sync hangs on large vaults',
  },
  {
    name: 'leaves no trailing space when the cut lands on one',
    note: `${'w'.repeat(199)} tail`,
    title: 'w'.repeat(199),
  },
  {
    name: 'leaves a title of exactly the ceiling untouched',
    note: 'z'.repeat(200),
    title: 'z'.repeat(200),
  },
  {
    name: 'cuts a title one over the ceiling to exactly the ceiling',
    note: 'z'.repeat(201),
    title: 'z'.repeat(200),
  },
  {
    name: 'caps a very long first line at the title ceiling',
    note: `${'x'.repeat(250)} tail`,
    title: 'x'.repeat(200),
  },
  {
    name: 'caps without leaving half an astral character at the cut',
    note: `${'y'.repeat(199)}\u{1F600} tail`,
    title: 'y'.repeat(199),
  },
  {
    name: 'keeps a bullet marker, which introduces one step rather than wrapping the line',
    note: '- app freezes on save\n- then the window goes white',
    title: '- app freezes on save',
  },
  {
    name: 'keeps a numbered-list marker for the same reason',
    note: '1. open the vault\n2. paste a wide table',
    title: '1. open the vault',
  },
  {
    name: 'strips an ATX marker indented within the three spaces CommonMark allows',
    note: '   # Sync hangs on large vaults',
    title: 'Sync hangs on large vaults',
  },
  {
    name: 'strips a block-quote marker the reporter indented',
    note: ' > ENOENT opening the vault',
    title: 'ENOENT opening the vault',
  },
  {
    name: 'strips an ATX marker the reporter opened with a tab',
    note: '\t# The editor froze',
    title: 'The editor froze',
  },
  {
    name: 'leaves no double space when an invisible sat between two spaces',
    note: 'sync \u200B hangs on large vaults',
    title: 'sync hangs on large vaults',
  },
  {
    name: 'strips a marker hidden behind a leading zero-width character',
    note: '\u200B# The editor froze',
    title: 'The editor froze',
  },
  {
    name: 'drops a bidi override rather than letting it reorder the title',
    note: '\u202ESync hangs on large vaults',
    title: 'Sync hangs on large vaults',
  },
  {
    name: 'falls through a line of only zero-width characters',
    note: '\u200B\uFEFF\nThe editor froze',
    title: 'The editor froze',
  },
  {
    name: 'has no title when every line is invisible',
    note: '\u200B\n\u202E',
    title: undefined,
  },
  {
    name: 'maps a control character to a space instead of joining the words',
    note: 'editor\u0000froze',
    title: 'editor froze',
  },
  {
    name: 'maps an embedded tab to a space instead of joining the words',
    note: 'editor\tfroze',
    title: 'editor froze',
  },
  {
    name: 'collapses non-breaking spaces and runs of spaces',
    note: 'Sync\u00A0\u00A0hangs   on   large vaults',
    title: 'Sync hangs on large vaults',
  },
  { name: 'strips a level-1 ATX marker', note: '# The editor froze', title: 'The editor froze' },
  { name: 'strips a level-2 ATX marker', note: '## The editor froze', title: 'The editor froze' },
  { name: 'strips a level-3 ATX marker', note: '### The editor froze', title: 'The editor froze' },
  { name: 'strips a level-4 ATX marker', note: '#### The editor froze', title: 'The editor froze' },
  {
    name: 'strips a level-5 ATX marker',
    note: '##### The editor froze',
    title: 'The editor froze',
  },
  {
    name: 'strips a level-6 ATX marker',
    note: '###### The editor froze',
    title: 'The editor froze',
  },
  {
    name: 'leaves a seven-hash line alone, since CommonMark reads no heading there',
    note: '####### The editor froze',
    title: '####### The editor froze',
  },
  {
    name: 'leaves a hashtag alone, since no whitespace follows the hash',
    note: '#regression in the editor',
    title: '#regression in the editor',
  },
  {
    name: 'strips a blockquote marker',
    note: '> ENOENT opening the vault',
    title: 'ENOENT opening the vault',
  },
  { name: 'strips stacked markers in a single call', note: '## # Hello', title: 'Hello' },
  {
    name: 'falls through to the next line when the first is a bare marker',
    note: '#\nThe editor froze',
    title: 'The editor froze',
  },
  {
    name: 'yields no title when every line normalizes to nothing',
    note: '#\n>\n   \n',
    title: undefined,
  },
  { name: 'yields no title for an empty note', note: '', title: undefined },
  { name: 'yields no title for an absent note', note: undefined, title: undefined },
];

describe('bugReportNoteTitle', () => {
  test.each(NOTE_TITLE_CASES)('$name', ({ note, title }) => {
    expect(bugReportNoteTitle(note)).toBe(title);
  });

  test('yields no title when the sidecar handed back a non-string', () => {
    expect(bugReportNoteTitle(42 as unknown as string)).toBeUndefined();
  });

  test('is idempotent, so re-deriving a row title cannot shift it', () => {
    for (const { note } of NOTE_TITLE_CASES) {
      const once = bugReportNoteTitle(note);
      expect(bugReportNoteTitle(once)).toBe(once);
    }
  });
});

describe('main and the renderer agree on what does not count', () => {
  // The two processes decide this separately: main asks whether a note is worth
  // persisting, the renderer whether one yields a title. A character either
  // side stopped recognizing would leave a sidecar claiming a note the row
  // refuses to title, and a retry would put it on the wire as the reporter's
  // words. Boundaries included deliberately — the ends of a range are what a
  // careless narrowing drops first.
  test.each([
    ['\u0000', 'NUL'],
    ['\u001F', 'C0 upper boundary'],
    ['\u007F', 'DEL'],
    ['\u200B', 'zero-width space'],
    ['\uFEFF', 'BOM'],
    ['\u202E', 'right-to-left override'],
  ])('a note of only %j (%s) is blank to main and titleless to the renderer', (ch) => {
    expect(isBlankNoteContent(ch)).toBe(true);
    expect(bugReportNoteTitle(ch)).toBeUndefined();
  });
});
