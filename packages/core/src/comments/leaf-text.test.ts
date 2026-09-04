import { getSchema, type JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { MarkdownManager } from '../markdown/index.ts';
import { commentQuoteText } from './leaf-text.ts';
import { findPassage } from './passage-match.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

function quote(md: string): string {
  const doc = schema.nodeFromJSON(mdManager.parse(md));
  return commentQuoteText(doc, 0, doc.content.size).trim();
}

function locate(md: string): string | null {
  const captured = quote(md);
  if (captured.length === 0) return null;
  const hit = findPassage(md, captured, { syntaxIn: 'haystack' });
  return hit ? md.slice(hit.start, hit.end) : null;
}

describe('text an inline atom contributes', () => {
  test('a wiki link reads as its target', () => {
    expect(quote('A [[page]] word.')).toBe('A page word.');
  });

  test('an aliased wiki link reads as the alias, which is what is on screen', () => {
    expect(quote('A [[page|Nice Name]] word.')).toBe('A Nice Name word.');
  });

  test('a tag reads with its `#`, which is on screen and part of the word', () => {
    expect(quote('A #tagname word.')).toBe('A #tagname word.');
  });

  test('inline math reads as its formula', () => {
    expect(quote('A $$x^2$$ word.')).toBe('A x^2 word.');
  });

  test('an image reads as its alt text', () => {
    expect(quote('A ![alt](img.png) word.')).toBe('A alt word.');
  });

  test('an atom contributes no line break to the paragraph it sits in', () => {
    expect(quote('Start [[page]] end.')).toBe('Start page end.');
  });
});

describe('text a promoted fence contributes', () => {
  test('a mermaid fence reads as its chart', () => {
    expect(quote('```mermaid\ngraph TD;\n  A-->B;\n```')).toBe('graph TD;\n  A-->B;');
  });

  test('a math block reads as its formula', () => {
    expect(quote('$$\nx = 1\n$$')).toBe('x = 1');
  });

  test('a promoted construct with no named prop falls back to its source', () => {
    expect(quote('{/* mdx expr */}')).toBe('{/* mdx expr */}');
  });

  test('a component WITH children still reads as its children', () => {
    expect(quote('<Callout type="info">\n  Body text\n</Callout>')).toBe('Body text');
  });

  test('a fence separates from the prose around it', () => {
    expect(quote('Before.\n\n```mermaid\ngraph TD;\n```\n\nAfter.')).toBe(
      'Before.\ngraph TD;\nAfter.',
    );
  });
});

describe('parity with ProseMirror textBetween', () => {
  test('paragraphs are still separated', () => {
    expect(quote('First para.\n\nSecond para.')).toBe('First para.\nSecond para.');
  });

  test('list items are still separated', () => {
    expect(quote('- First item\n- Second item')).toBe('First item\nSecond item');
  });

  test('table cells are still separated', () => {
    expect(quote('| A | B |\n| --- | --- |\n| one | two |')).toBe('A\nB\none\ntwo');
  });

  test('a code fence still reads as its code', () => {
    expect(quote('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });
});

describe('the captured quote anchors back to the body', () => {
  const CASES = [
    'A ==marked== word.',
    'A ![alt](img.png) word.',
    'A [[page]] word.',
    'A [[page|Alias]] word.',
    'A [[page#sec]] word.',
    'A #tagname word.',
    'A $$x^2$$ word.',
    'A claim[^1] word.',
    'A <u>under</u> word.',
    'A <http://x.com> word.',
    '```mermaid\ngraph TD;\n  A-->B;\n```',
    'Before.\n\n```mermaid\ngraph TD;\n```\n\nAfter.',
    'Before.\n\n$$\nx = 1\n$$\n\nAfter.',
    'See [[page]] and #tag with ==mark== plus $$y$$ and ![a](i.png).',
    'A &#x20; word.',
    '**bold&#x20;**tail',
    '~~***External apps &#x20;***[external action icon]~~',
    '&#x20; indented line',
  ];

  for (const md of CASES) {
    test(`anchors: ${JSON.stringify(md.slice(0, 44))}`, () => {
      expect(locate(md)).not.toBeNull();
    });
  }

  test('the boundary-space fixtures above are what the serializer actually mints', () => {
    const withBoundarySpace = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'strong' }], text: 'bold ' },
            { type: 'text', text: 'tail' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '  indented line' }] },
      ],
    };
    expect(mdManager.serialize(withBoundarySpace satisfies JSONContent)).toBe(
      '**bold&#x20;**tail\n\n&#x20; indented line\n',
    );
  });
});

describe('inlineOnly — for callers deciding whether text formatting applies', () => {
  function inlineQuote(md: string): string {
    const doc = schema.nodeFromJSON(mdManager.parse(md));
    return commentQuoteText(doc, 0, doc.content.size, ' ', { inlineOnly: true }).trim();
  }

  test('an inline atom still counts — it carries the marks a bar would apply', () => {
    expect(inlineQuote('A [[page]] word.')).toBe('A page word.');
  });

  test('a mermaid diagram does not count', () => {
    expect(inlineQuote('```mermaid\ngraph TD;\n```')).toBe('');
  });

  test('a math block does not count', () => {
    expect(inlineQuote('$$\nx = 1\n$$')).toBe('');
  });

  test('real block text is unaffected', () => {
    expect(inlineQuote('Just ordinary words.')).toBe('Just ordinary words.');
  });
});

describe('images and embeds', () => {
  test('an image reads as its alt text, not its markup', () => {
    expect(quote('![a cat asleep](cat.png)')).toBe('a cat asleep');
  });

  test('an image with no alt falls back to its source', () => {
    expect(quote('![](cat.png)')).toBe('![](cat.png)');
  });

  test('an embed falls back to its source', () => {
    expect(quote('<Embed src="https://example.com/a" />')).toBe(
      '<Embed src="https://example.com/a" />',
    );
  });

  test('each resolves to the span its quote names', () => {
    expect(locate('![a cat asleep](cat.png)')).toBe('a cat asleep');
    expect(locate('![](cat.png)')).toBe('![](cat.png)');
    expect(locate('<Embed src="https://x.co" />')).toBe('<Embed src="https://x.co" />');
  });
});

describe('attached files', () => {
  test('a file reads as its title when it has one', () => {
    expect(quote('<File src="docs/spec.pdf" name="The Spec" />')).toBe('The Spec');
  });

  test('a file with no title falls back to its source', () => {
    expect(quote('<File src="docs/spec.pdf" />')).toBe('<File src="docs/spec.pdf" />');
  });

  test('a wiki file embed reads as its target, having no source to fall back on', () => {
    expect(quote('![[report.pdf]]')).toBe('report.pdf');
  });

  test('a video falls back to its source', () => {
    expect(quote('<video src="clip.mp4" />')).toBe('<video src="clip.mp4" />');
  });

  test('each resolves to the span its quote names', () => {
    expect(locate('<File src="docs/spec.pdf" name="The Spec" />')).toBe('The Spec');
    expect(locate('![[report.pdf]]')).toBe('report.pdf');
    expect(locate('<File src="docs/spec.pdf" />')).toBe('<File src="docs/spec.pdf" />');
    expect(locate('<video src="clip.mp4" />')).toBe('<video src="clip.mp4" />');
  });
});

describe('block separation', () => {
  function para(text?: string) {
    return text === undefined
      ? { type: 'paragraph' }
      : { type: 'paragraph', content: [{ type: 'text', text }] };
  }

  test('an empty paragraph consumes a separator, as it does in textBetween', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [para('First.'), para(), para('Second.')],
    });
    expect(commentQuoteText(doc, 0, doc.content.size)).toBe('First.\n\nSecond.');
  });

  test('two paragraphs are separated by exactly one break', () => {
    expect(quote('First.\n\nSecond.')).toBe('First.\nSecond.');
  });
});

describe('inline components', () => {
  test('a registered inline component reads as its body', () => {
    expect(quote('Read <Callout type="note">body text</Callout> here.')).toBe(
      'Read body text here.',
    );
  });

  test('and that quote anchors over the whole construct', () => {
    expect(locate('Read <Callout type="note">body text</Callout> here.')).toBe(
      'Read <Callout type="note">body text</Callout> here.',
    );
  });

  test('an unregistered tag still reads as its source', () => {
    expect(quote('Read <Unregistered>raw</Unregistered> here.')).toBe(
      'Read <Unregistered>raw</Unregistered> here.',
    );
  });

  test('a self-closing inline tag still reads as its source', () => {
    expect(quote('Read <Icon name="x" /> here.')).toBe('Read <Icon name="x" /> here.');
  });
});
