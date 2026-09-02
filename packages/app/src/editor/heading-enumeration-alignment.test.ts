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
    name: 'CRLF line endings',
    lines: ['# Intro\r', '\r', '## Details\r', ''],
  },
  {
    name: 'CRLF line endings with an in-frontmatter hash',
    lines: ['---\r', 'title: Doc\r', '# yaml comment, not a heading\r', '---\r', '\r', '# Real\r'],
  },
];

describe('client/server heading enumeration agreement', () => {
  for (const { name, lines } of CASES) {
    test(name, () => {
      const md = lines.join('\n');

      const clientDoc = EditorState.create({ doc: md }).doc;
      const client = sourceHeadingLines(clientDoc).map((entry: SourceHeadingLine) => entry.slug);
      const server = extractHeadings(md).map((heading) => heading.slug);

      expect(server.length).toBeGreaterThan(0);
      expect(client).toEqual(server);
    });
  }
});
