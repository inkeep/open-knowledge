import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { describe, expect, test } from 'vitest';
import {
  componentNames,
  escapeInlineProse,
  escapeRawHtml,
  markdownLink,
  type SerializerRegistry,
  STRINGIFY_OPTIONS,
  serializeMdx,
} from './mdx-serializer.ts';

const PAGE_URL = 'https://openknowledge.ai/docs/get-started/quickstart';

function body(source: string, registry: SerializerRegistry = {}): string {
  return serializeMdx(source, { registry, pageUrl: PAGE_URL }).body;
}

describe('serializeMdx', () => {
  test('serializes a page with frontmatter, a wrapper component, and a relative link', () => {
    const { frontmatter, body: md } = serializeMdx(
      [
        '---',
        'title: "Quickstart"',
        'description: Get running in five minutes',
        '---',
        '',
        '<Callout type="tip">',
        '  Read the [editor guide](../features/editor.mdx#ask-ai) first.',
        '</Callout>',
        '',
        '- one',
        '- two',
        '',
      ].join('\n'),
      { registry: { Callout: 'flatten' }, pageUrl: PAGE_URL },
    );

    expect(frontmatter).toEqual({
      title: 'Quickstart',
      description: 'Get running in five minutes',
    });
    expect(md).toBe(
      [
        'Read the [editor guide](https://openknowledge.ai/docs/features/editor#ask-ai) first.',
        '',
        '- one',
        '- two',
      ].join('\n'),
    );
  });
});

describe('component dispositions', () => {
  test('a component with no disposition fails loudly and names the fix', () => {
    expect(() => body('<Widget>content</Widget>')).toThrow(
      /No serializer disposition for <Widget>.*Add "Widget" to the registry/s,
    );
  });

  test.each([
    'toString',
    'constructor',
    'valueOf',
  ])('a name Object.prototype carries (%s) is refused, not resolved through the prototype', (name) => {
    expect(() => body(`<${name} />`)).toThrow(/No serializer disposition/);
  });

  test('flatten keeps the children and discards the tag', () => {
    expect(body('<Wrapper>\n\nkept text\n\n</Wrapper>', { Wrapper: 'flatten' })).toBe('kept text');
  });

  test('flatten reaches components nested inside other components', () => {
    const md = body('<Outer>\n\n<Inner>deep text</Inner>\n\n</Outer>', {
      Outer: 'flatten',
      Inner: 'flatten',
    });
    expect(md).toBe('deep text');
  });

  test('drop removes the component and everything inside it', () => {
    const md = body('before\n\n<Nav>\n\nnavigation\n\n</Nav>\n\nafter', { Nav: 'drop' });
    expect(md).toBe('before\n\nafter');
  });

  test('a custom serializer emits its markdown verbatim', () => {
    const md = body('<Mermaid chart="graph TD; A-->B" />', {
      Mermaid: (node, api) => `\`\`\`mermaid\n${api.attribute(node, 'chart')}\n\`\`\``,
    });
    expect(md).toBe('```mermaid\ngraph TD; A-->B\n```');
  });

  test('a custom serializer can render the children it was given', () => {
    const md = body('<Callout title="Heads up">\n\nBe careful.\n\n</Callout>', {
      Callout: (node, api) => `> **${api.attribute(node, 'title')}**\n>\n> ${api.children(node)}`,
    });
    expect(md).toBe('> **Heads up**\n>\n> Be careful.');
  });

  test('a custom serializer reads expression attributes as source', () => {
    let seen: string | undefined;
    body("<Tabs items={['CLI', 'UI']}>\n\ncontent\n\n</Tabs>", {
      Tabs: (node, api) => {
        seen = api.expressionAttribute(node, 'items');
        return api.children(node);
      },
    });
    expect(seen).toBe("['CLI', 'UI']");
  });

  test('a custom serializer returning null drops the component', () => {
    expect(body('kept\n\n<Aside>gone</Aside>', { Aside: () => null })).toBe('kept');
  });

  test('a fragment contributes its children without a registry entry', () => {
    expect(body('<>\n\nfragment text\n\n</>')).toBe('fragment text');
  });

  test('imports and expressions carry no prose and are removed', () => {
    const md = body("import { Clock } from 'lucide-react';\n\ntext\n\n{ 2 + 2 }");
    expect(md).toBe('text');
  });
});

describe('frontmatter', () => {
  test('is YAML-parsed, so quoting never leaks into a value', () => {
    const { frontmatter } = serializeMdx('---\ntitle: "Mirror"\n---\n\nbody\n', {
      registry: {},
      pageUrl: PAGE_URL,
    });
    expect(frontmatter.title).toBe('Mirror');
  });

  test('is stripped before the MDX parse, so raw HTML in a description is inert', () => {
    const source = [
      '---',
      'title: "Accordion"',
      'description: "Expand/collapse via native HTML5 <details>/<summary>."',
      '---',
      '',
      'Prose.',
      '',
    ].join('\n');
    const { frontmatter, body: md } = serializeMdx(source, { registry: {}, pageUrl: PAGE_URL });
    expect(frontmatter.description).toContain('<details>/<summary>');
    expect(md).toBe('Prose.');
  });

  test('a source with no frontmatter yields an empty mapping', () => {
    const { frontmatter, body: md } = serializeMdx('Just prose.\n', {
      registry: {},
      pageUrl: PAGE_URL,
    });
    expect(frontmatter).toEqual({});
    expect(md).toBe('Just prose.');
  });

  test('frontmatter that is not a mapping fails loudly', () => {
    expect(() =>
      serializeMdx('---\n- a\n- b\n---\n\nbody\n', { registry: {}, pageUrl: PAGE_URL }),
    ).toThrow(/Frontmatter must be a YAML mapping/);
  });
});

describe('link rewriting', () => {
  test.each([
    [
      'parent-relative source link',
      '[a](../features/editor.mdx)',
      'https://openknowledge.ai/docs/features/editor',
    ],
    [
      'sibling-relative source link',
      '[a](./overview.mdx)',
      'https://openknowledge.ai/docs/get-started/overview',
    ],
    [
      'a .md sibling',
      '[a](../reference/core-concepts.md)',
      'https://openknowledge.ai/docs/reference/core-concepts',
    ],
    [
      'a fragment on a relative link',
      '[a](../features/editor.mdx#ask-ai)',
      'https://openknowledge.ai/docs/features/editor#ask-ai',
    ],
    ['a root-relative link', '[a](/download)', 'https://openknowledge.ai/download'],
    [
      'a bare fragment',
      '[a](#section)',
      'https://openknowledge.ai/docs/get-started/quickstart#section',
    ],
    ['an image', '![a](/screenshots/x.png)', 'https://openknowledge.ai/screenshots/x.png'],
  ])('absolutises %s', (_label, source, expected) => {
    expect(body(source)).toContain(`(${expected})`);
  });

  test.each([
    ['an external URL that happens to end in .md', 'https://github.com/o/r/blob/main/SPEC.md'],
    ['a mailto link', 'mailto:hi@openknowledge.ai'],
    ['a protocol-relative URL', '//cdn.example.com/x.png'],
  ])('leaves %s untouched', (_label, url) => {
    expect(body(`[a](${url})`)).toContain(`(${url})`);
  });

  test('rewrites a link reference definition', () => {
    expect(body('[a][ref]\n\n[ref]: ../features/editor.mdx\n')).toContain(
      'https://openknowledge.ai/docs/features/editor',
    );
  });

  test('rewrites links inside a component that is flattened away', () => {
    const md = body('<Callout>\n\n[a](../features/editor.mdx)\n\n</Callout>', {
      Callout: 'flatten',
    });
    expect(md).toContain('https://openknowledge.ai/docs/features/editor');
  });
});

describe('pinned stringify options', () => {
  test('are the exact set both apps depend on', () => {
    expect(STRINGIFY_OPTIONS).toEqual({ bullet: '-', rule: '-', listItemIndent: 'one' });
  });

  test('emit hyphen bullets, hyphen rules, and single-space list indent', () => {
    const md = body('* one\n  * nested\n\n***\n');
    expect(md).toBe('- one\n  - nested\n\n---');
  });

  test('never indent a code block to the four-space column', () => {
    const md = body('```\nplain fence\n```\n');
    expect(md).toBe('```\nplain fence\n```');
  });
});

describe('escapeRawHtml', () => {
  test('turns a tag named in prose into the words it reads as', () => {
    expect(escapeRawHtml('Standalone expand/collapse via native HTML5 <details>/<summary>.')).toBe(
      'Standalone expand/collapse via native HTML5 \\<details>/\\<summary>.',
    );
  });

  test('leaves a tag named inside a code span alone, where it is already inert', () => {
    const prose = 'Each `<Tab>` child is one panel.';
    expect(escapeRawHtml(prose)).toBe(prose);
  });

  test('keeps the inline formatting the author wrote', () => {
    const prose = 'Prefer **the editor**, or read [the guide](https://openknowledge.ai/docs).';
    expect(escapeRawHtml(prose)).toBe(prose);
  });

  test('gives block-level markup a paragraph of its own', () => {
    expect(escapeRawHtml('<div align="center">\n\nCentred.\n\n</div>')).toBe(
      '\\<div align="center">\n\nCentred.\n\n\\</div>',
    );
  });

  test('leaves prose carrying no markup byte-identical', () => {
    const prose = 'What OpenKnowledge is, and why it exists.';
    expect(escapeRawHtml(prose)).toBe(prose);
  });
});

describe('componentNames', () => {
  test('names every element, component and lowercase HTML alike', () => {
    expect(componentNames('<Callout>text</Callout>\n\n<code>x</code>\n').sort()).toEqual([
      'Callout',
      'code',
    ]);
  });

  test('ignores an element inside a fenced code block', () => {
    expect(componentNames('```mdx\n<Callout>example</Callout>\n```\n')).toEqual([]);
  });

  test('ignores an element inside an inline code span', () => {
    expect(componentNames('Write `<Callout>` to add one.\n')).toEqual([]);
  });

  test('ignores markup in frontmatter', () => {
    const source = ['---', 'description: The <details> element', '---', '', 'Body.', ''].join('\n');
    expect(componentNames(source)).toEqual([]);
  });

  test('reaches nested and inline elements, and names each once', () => {
    const source = '<Tabs>\n  <Tab>a <InlineIcon /> b</Tab>\n  <Tab>c</Tab>\n</Tabs>\n';
    expect(componentNames(source).sort()).toEqual(['InlineIcon', 'Tab', 'Tabs']);
  });

  test('ignores a fragment, which has no name to look up', () => {
    expect(componentNames('<>\n  <Card>a</Card>\n</>\n')).toEqual(['Card']);
  });
});

describe('the docs content corpus', () => {
  const CONTENT_ROOT = fileURLToPath(new URL('../../content/', import.meta.url));
  const FLATTEN_EVERY_COMPONENT = new Proxy(
    {},
    {
      get: () => 'flatten',
      getOwnPropertyDescriptor: () => ({
        value: 'flatten',
        configurable: true,
        enumerable: true,
        writable: true,
      }),
    },
  ) as SerializerRegistry;

  function corpusFiles(dir = CONTENT_ROOT): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return corpusFiles(full);
      return /\.mdx?$/.test(entry.name) ? [full] : [];
    });
  }

  function pageUrlFor(file: string): string {
    const slug = path
      .relative(CONTENT_ROOT, file)
      .replace(/\.mdx?$/, '')
      .replace(/(^|\/)index$/, '');
    return `https://openknowledge.ai/docs/${slug}`.replace(/\/$/, '');
  }

  const files = corpusFiles();

  function hrefsIn(markdown: string): string[] {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    const urls: string[] = [];
    visit(tree, (node) => {
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
        urls.push(node.url);
      }
    });
    return urls;
  }

  test('is non-empty, so a broken glob cannot vacuously pass this suite', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('serializes every page with no parse failures and no source-form links', async () => {
    const failures: string[] = [];

    await Promise.all(
      files.map(async (file) => {
        const rel = path.relative(CONTENT_ROOT, file);
        let md: string;
        try {
          md = serializeMdx(await readFile(file, 'utf8'), {
            registry: FLATTEN_EVERY_COMPONENT,
            pageUrl: pageUrlFor(file),
          }).body;
        } catch (error) {
          failures.push(`${rel}: ${(error as Error).message}`);
          return;
        }
        for (const href of hrefsIn(md)) {
          if (href.startsWith('../') || href.startsWith('./')) {
            failures.push(`${rel}: relative href survived (${href})`);
          }
          if (/\.mdx($|[#?])/.test(href)) {
            failures.push(`${rel}: source-form .mdx href survived (${href})`);
          }
        }
      }),
    );

    expect(failures).toEqual([]);
  });
});

describe('a refusal names the page it came from', () => {
  test('prefixes the page URL, so the corpus route does not report 68 candidates', () => {
    expect(() =>
      serializeMdx('<Unknown />', {
        registry: {},
        pageUrl: 'https://openknowledge.ai/docs/x/y',
      }),
    ).toThrow('https://openknowledge.ai/docs/x/y: No serializer disposition for <Unknown>');
  });

  test('keeps the original refusal reachable as the cause', () => {
    const thrown = (() => {
      try {
        serializeMdx('<Unknown />', { registry: {}, pageUrl: 'https://openknowledge.ai/docs/x' });
      } catch (error) {
        return error as Error;
      }
    })();

    expect((thrown?.cause as Error).message).toBe(
      "No serializer disposition for <Unknown>. Add \"Unknown\" to the registry as 'flatten', 'drop', or a custom serializer.",
    );
  });
});

describe('markdownLink', () => {
  const parse = unified().use(remarkParse).use(remarkGfm);

  function linkIn(markdown: string): { url: string; text: string } | undefined {
    let found: { url: string; text: string } | undefined;
    visit(parse.parse(markdown), 'link', (node) => {
      const words: string[] = [];
      visit(node, (child) => {
        if (child.type === 'text' || child.type === 'inlineCode') words.push(child.value);
      });
      found = { url: node.url, text: words.join('') };
    });
    return found;
  }

  test.each([
    ['an unbalanced bracket in the label', 'Unmatched ] here', 'https://x.test/a.md'],
    ['balanced brackets in the label', 'Array[0] access', 'https://x.test/a.md'],
    ['a parenthesis in the destination', 'Note', 'https://x.test/blog/note-)-end.md'],
    ['a space in the destination', 'Note', 'https://x.test/blog/pre post.md'],
  ])('round-trips %s', (_name, label, url) => {
    expect(linkIn(markdownLink(label, url))).toEqual({ url, text: label });
  });

  test.each([
    ['an ordered-list marker', '1. Install the CLI'],
    ['a heading marker', '# Overview'],
    ['a bullet marker', '- Quickstart'],
    ['a blockquote marker', '> Note'],
    ['a thematic break', '---'],
  ])('keeps a label opening with %s', (_name, label) => {
    expect(linkIn(markdownLink(label, 'https://x.test/a.md'))).toEqual({
      url: 'https://x.test/a.md',
      text: label,
    });
  });

  test.each([
    'Install claude_desktop_config.json',
    '1. Install claude_desktop_config.json',
    'Use [brackets] here',
    '1. Use [brackets] here',
    'Set up ~/.codex/config.toml',
    '- Set up ~/.codex/config.toml',
    'Read the C++ <T> guide',
    '1. Read the C++ <T> guide',
    '# Roadmap',
  ])('serves %s as written through the production composition', (authored) => {
    expect(linkIn(markdownLink(escapeInlineProse(authored), 'https://x.test/a.md'))).toEqual({
      url: 'https://x.test/a.md',
      text: authored,
    });
  });

  test('folds a label that parses to several blocks onto its one line', () => {
    expect(linkIn(markdownLink('para one\n\npara two', 'https://x.test/a.md'))).toEqual({
      url: 'https://x.test/a.md',
      text: 'para one para two',
    });
  });

  test('carries a block-opening label into the image branch too', () => {
    let alt: string | undefined;
    visit(
      parse.parse(markdownLink('1. The editor', 'https://x.test/h.png', { image: true })),
      'image',
      (node) => {
        alt = node.alt ?? undefined;
      },
    );
    expect(alt).toBe('1. The editor');
  });

  test('leaves a code span in the label byte-identical', () => {
    const rendered = markdownLink('Use ``a`b]c`` today', 'https://x.test/a.md');

    expect(rendered).toBe('[Use ``a`b]c`` today](https://x.test/a.md)');
    expect(rendered).not.toContain('\\]');
  });

  test('flattens a nested link, which CommonMark forbids in a label', () => {
    const rendered = markdownLink('see [the docs](https://x.test/docs)', 'https://x.test/a.md');
    expect(linkIn(rendered)).toEqual({ url: 'https://x.test/a.md', text: 'see the docs' });
  });

  test('renders an image when asked, with the label as alt text', () => {
    let alt: string | undefined;
    let url: string | undefined;
    visit(
      parse.parse(markdownLink('The editor', 'https://x.test/hero.png', { image: true })),
      'image',
      (n) => {
        alt = n.alt ?? undefined;
        url = n.url;
      },
    );
    expect({ alt, url }).toEqual({ alt: 'The editor', url: 'https://x.test/hero.png' });
  });
});

describe('one escaping rule for author prose placed into authored Markdown', () => {
  const parse = unified().use(remarkParse).use(remarkGfm);

  test.each([
    ['raw HTML a writer names in passing', 'the <summary> element', 'the <summary> element'],
    ['a code span containing a tag', 'Use the `<b>` tag', 'Use the <b> tag'],
  ])('round-trips %s', (_name, prose, expected) => {
    const label = escapeInlineProse(prose);
    const words: string[] = [];
    visit(parse.parse(markdownLink(label, 'https://x.test/a.md')), (node) => {
      if (node.type === 'text' || node.type === 'inlineCode') words.push(node.value);
    });

    expect(words.join('')).toBe(expected);
  });
});
