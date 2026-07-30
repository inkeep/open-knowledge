/**
 * Cross-producer agreement: the source-mode heading enumerator must see exactly
 * the same headings, in the same order, with the same slugs, as the server's
 * outline producer.
 *
 * The outline rows come from the server; source-mode navigation and
 * active-heading tracking resolve them against client-side line offsets. The
 * two are joined by ordinal alone, so any line one producer admits and the
 * other skips shifts every row after it — a silent off-by-N that looks like a
 * scroll bug rather than a scan bug.
 *
 * Expected values come from the independent producer, never from a slug array
 * written here, so the test cannot be satisfied by back-fitting a constant to
 * whatever the client happens to do.
 */

import { EditorState } from '@codemirror/state';
import { extractHeadings } from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import { type SourceHeadingLine, sourceHeadingLines } from './source-heading-lines';

interface Case {
  name: string;
  lines: string[];
}

const CASES: Case[] = [
  {
    name: 'an ordinary document spanning every heading level',
    lines: [
      '# Title',
      '',
      'Intro prose.',
      '',
      '## Section',
      '',
      '### Subsection',
      '',
      '#### Deeper',
      '',
      '##### Deeper still',
      '',
      '###### Deepest',
      '',
      'Closing prose.',
    ],
  },
  {
    name: 'duplicate heading text, ASCII and non-ASCII',
    lines: ['# Notes', '', '## Notes', '', '## 東京', '', '## 東京', '', '## notes'],
  },
  {
    name: 'hashes with no heading text',
    lines: ['# Real', '', '### ', '', '###   ', '', '## After'],
  },
  {
    name: 'heading text that slugs to nothing',
    lines: ['# Real', '', '## ---', '', '## ***', '', '## After'],
  },
  {
    name: 'hashes with no separating whitespace',
    lines: ['# Real', '', '#NoSpace', '', '## After'],
  },
  {
    name: 'a seventh hash',
    lines: ['# Real', '', '####### Seven', '', '## After'],
  },
  {
    name: 'an indented hash line',
    lines: ['# Real', '', '  ## Indented', '', '## After'],
  },
  {
    name: 'frontmatter containing a YAML comment',
    lines: ['---', 'title: Doc', '# yaml comment, not a heading', '---', '', '# Real Heading'],
  },
  {
    name: 'frontmatter whose opening fence carries a trailing space',
    lines: ['--- ', 'title: Doc', '# yaml comment, not a heading', '---', '', '# Real Heading'],
  },
  {
    name: 'frontmatter whose closing fence carries a trailing tab',
    lines: ['---', 'title: Doc', '# yaml comment, not a heading', '---\t', '', '# Real Heading'],
  },
  {
    name: 'an unclosed leading fence, which is body for both producers',
    lines: ['---', 'title: Never closed', '# Looks like yaml', '', '## After'],
  },
  {
    name: 'a mid-document thematic break',
    lines: ['# Real', '', '---', '', '## After'],
  },
  {
    name: 'a backtick code fence containing a hash line',
    lines: [
      '# Top',
      '',
      '```yaml',
      '# electron-builder.yml',
      'appId: com.example',
      '```',
      '',
      '## After',
    ],
  },
  {
    name: 'a tilde code fence containing a hash line',
    lines: ['# Top', '', '~~~bash', '# not a heading', '~~~', '', '## After'],
  },
  {
    name: 'an unclosed code fence swallowing the rest of the document',
    lines: ['# Real', '', '```js', '# inside', '## still inside'],
  },
  {
    // A CRLF document. The client builds its doc the way production does (see the
    // `EditorState.create` below), which splits on CodeMirror's DefaultSplit and
    // drops the `\r` before the enumerator runs — while the server scans the raw
    // `\r`-bearing bytes. Both must still agree.
    name: 'CRLF line endings',
    lines: ['# Intro\r', '\r', '## Details\r', ''],
  },
  {
    // CRLF plus frontmatter whose body carries a hash line: the client's
    // frontmatter partition and the server's must agree on skipping it, or that
    // in-frontmatter `# …` surfaces as a phantom heading and shifts every ordinal.
    name: 'CRLF line endings with an in-frontmatter hash',
    lines: ['---\r', 'title: Doc\r', '# yaml comment, not a heading\r', '---\r', '\r', '# Real\r'],
  },
];

describe('client/server heading enumeration agreement', () => {
  for (const { name, lines } of CASES) {
    test(name, () => {
      const md = lines.join('\n');

      // Build the client doc exactly as the running editor does: `EditorState.create`
      // splits the string on CodeMirror's DefaultSplit (`/\r\n?|\n/`), so a CRLF
      // document reaches `sourceHeadingLines` with the `\r` already stripped.
      // Splitting on `\n` alone here would feed the enumerator a `\r` production
      // never delivers, testing a path the editor cannot take.
      const clientDoc = EditorState.create({ doc: md }).doc;
      const client = sourceHeadingLines(clientDoc).map((entry: SourceHeadingLine) => entry.slug);
      const server = extractHeadings(md).map((heading) => heading.slug);

      // Every fixture carries at least one real heading, so a case cannot pass
      // by both producers finding nothing.
      expect(server.length).toBeGreaterThan(0);
      expect(client).toEqual(server);
    });
  }
});
