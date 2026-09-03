import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { beforeAll, describe, expect, test } from 'vitest';
import { AGENTS } from '../components/agent-icons.tsx';
import { LAYERS, PATHS } from '../components/overview-blocks.tsx';
import { type CorpusPage, readCorpus } from './docs-corpus.test-helper.ts';
import { DOWNLOAD_TARGETS } from './download-targets.ts';
import { serializeMdx } from './mdx-serializer.ts';
import { DOCS_SERIALIZER_REGISTRY } from './mdx-serializer-registry.ts';

const PAGE_URL = 'https://openknowledge.ai/docs/get-started/quickstart';

function serialize(source: string, pageUrl = PAGE_URL): string {
  return serializeMdx(source, { registry: DOCS_SERIALIZER_REGISTRY, pageUrl }).body;
}

describe('components that carry their content in attributes', () => {
  test('a callout becomes a blockquote led by its title', () => {
    expect(serialize('<Callout type="info" title="Verify Git">\n\nRun it.\n\n</Callout>')).toBe(
      '> **Verify Git**\n>\n> Run it.',
    );
  });

  test('an untitled callout keeps its variant, which is its only severity signal', () => {
    expect(serialize('<Callout type="warning">\n\nThis bites.\n\n</Callout>')).toBe(
      '> **Warning**\n>\n> This bites.',
    );
  });

  test('a TypeTable becomes a table with a row per prop', () => {
    const md = serialize(
      `<TypeTable type={{ "src": { description: 'Image source', type: 'string', required: true } }} />`,
    );
    expect(md).toContain('| Prop | Type | Required | Default | Description |');
    expect(md).toContain('| `src` | `string` | yes |  | Image source |');
  });

  test.each([
    ['true', 'yes'],
    ['1', 'yes'],
    ['false', 'no'],
    ['0', 'no'],
  ])('a `required` of %s reads as %s, as the rendered table shows it', (value, expected) => {
    const md = serialize(`<TypeTable type={{ "src": { type: 'string', required: ${value} } }} />`);
    expect(md).toContain(`| \`src\` | \`string\` | ${expected} |`);
  });

  test('a generic type reaches the reader as it was written', () => {
    const md = serialize(`<TypeTable type={{ "items": { type: 'Array<string>' } }} />`);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(md);

    const spans: string[] = [];
    visit(tree, 'inlineCode', (node) => spans.push(node.value));
    expect(spans).toContain('Array<string>');
  });

  test('a TypeTable cell escapes a pipe inside a union type rather than splitting the column', () => {
    const md = serialize(`<TypeTable type={{ "kind": { type: "'a' | 'b'" } }} />`);
    expect(md).toContain("| `'a' \\| 'b'` |");
  });

  test('prose naming an HTML tag survives as words, not as an unclosed tag', () => {
    const md = serialize(`<TypeTable type={{ "title": { description: 'Shown in <summary>' } }} />`);
    expect(md).toContain(String.raw`Shown in \<summary>`);
  });

  test('a Mermaid chart becomes a mermaid fence', () => {
    expect(serialize('<Mermaid chart={`graph LR\nA --> B`} />')).toBe(
      '```mermaid\ngraph LR\nA --> B\n```',
    );
  });

  test('a base64 HtmlPreview attribute is decoded back to its preview fence', () => {
    const encoded = Buffer.from('<p>hi</p>', 'utf8').toString('base64');
    expect(serialize(`<HtmlPreview code="${encoded}" />`)).toBe('```html preview\n<p>hi</p>\n```');
  });

  test('an icon carrying an accessible name contributes that name to the sentence', () => {
    expect(serialize('Click the <Clock role="img" aria-label="Timeline" /> icon.')).toBe(
      'Click the Timeline icon.',
    );
  });

  test('a decorative icon with no accessible name contributes nothing', () => {
    expect(serialize('Click the <InlineIcon name="Bell" /> bell.')).toBe('Click the  bell.');
  });
});

describe('inputs the registry refuses rather than serializes wrong', () => {
  test('a TypeTable whose rows are a free identifier is refused, naming it', () => {
    expect(() => serialize('<TypeTable type={PROP_ROWS} />')).toThrow(
      'identifier "PROP_ROWS" is not a literal',
    );
  });

  test('a TypeTable without its rows object is refused', () => {
    expect(() => serialize('<TypeTable />')).toThrow(
      '<TypeTable> carries its rows in a `type` object, which is missing.',
    );
  });

  test('a TypeTable whose literal is not an object of descriptors is refused', () => {
    expect(() => serialize("<TypeTable type={['src']} />")).toThrow(
      '<TypeTable type={…}> must be an object of prop descriptors.',
    );
  });

  test('a TypeTable whose type is a quoted string is refused without claiming it is missing', () => {
    expect(() => serialize('<TypeTable type="string" />')).toThrow(
      'must be a braced object expression',
    );
  });

  test('a TypeTable descriptor that is not an object is refused, naming the prop', () => {
    expect(() => serialize(`<TypeTable type={{ src: 'string' }} />`)).toThrow(
      'descriptor for `src` must be an object',
    );
  });

  test('a TypeTable field holding an object is refused, naming the field', () => {
    expect(() => serialize(`<TypeTable type={{ src: { type: { kind: 'string' } } }} />`)).toThrow(
      '`src.type` must be a string, number or boolean',
    );
  });

  test('a TypeTable field holding an array is refused too', () => {
    expect(() => serialize(`<TypeTable type={{ src: { default: ['a', 'b'] } }} />`)).toThrow(
      '`src.default` must be a string, number or boolean',
    );
  });

  test.each([
    ['<Image src={hero} alt="Editor" />', 'Image'],
    ['<img src={hero} alt="Editor" />', 'img'],
  ])('refuses %s rather than deleting it from the rendition', (source, name) => {
    expect(() => serialize(source)).toThrow(
      new RegExp(`<${name} src=\\{hero\\}> carries its value in an expression`),
    );
  });

  test('names the absent case differently from the unreadable one', () => {
    expect(() => serialize('<img alt="Editor" />')).toThrow('<img> has no `src`');
  });

  test('a Tabs items expression that is not an array is refused', () => {
    expect(() => serialize('<Tabs items={{ first: 1 }} />')).toThrow(
      '<Tabs items={…}> must be an array of labels.',
    );
  });

  test('an HtmlPreview whose code is not base64 is refused rather than shipped as mojibake', () => {
    expect(() => serialize('<HtmlPreview code="<p>hi</p>" />')).toThrow('is not valid base64');
  });

  test.each([
    ['a`b', 'a`b'],
    ['``', '``'],
    ['`start', '`start'],
    ['end`', 'end`'],
  ])('an inline code span carrying %j round-trips as one span', (value, expected) => {
    const md = serialize(`<code>${value}</code>`);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(md);

    const spans: string[] = [];
    visit(tree, 'inlineCode', (node) => {
      spans.push(node.value);
    });
    expect(spans).toEqual([expected]);
  });

  test.each([
    ['base64url', (value: string) => value.replaceAll('+', '-').replaceAll('/', '_')],
    ['line-wrapped', (value: string) => value.replace(/(.{8})/g, '$1\n')],
  ])('accepts a %s spelling the decoder reads in full', (_name, respell) => {
    const html = '<p>hi &amp; bye</p>';
    const encoded = respell(Buffer.from(html, 'utf8').toString('base64'));

    expect(serialize(`<HtmlPreview code="${encoded}" />`)).toBe(
      `\`\`\`html preview\n${html}\n\`\`\``,
    );
  });

  test('a preview body carrying backtick runs gets a fence longer than the runs', () => {
    const encoded = Buffer.from('<code>```</code>', 'utf8').toString('base64');
    expect(serialize(`<HtmlPreview code="${encoded}" />`)).toBe(
      '````html preview\n<code>```</code>\n````',
    );
  });

  test('a Mermaid without a chart is refused', () => {
    expect(() => serialize('<Mermaid />')).toThrow('<Mermaid> needs a `chart` string.');
  });

  test('an HtmlPreview without its encoded block is refused', () => {
    expect(() => serialize('<HtmlPreview />')).toThrow(
      '<HtmlPreview> carries its block in a `code` attribute, which is missing.',
    );
  });
});

describe('tab groups', () => {
  test('each panel becomes a heading taken from the items list', () => {
    const md = serialize(
      "<Tabs items={['Desktop app', 'Web app']}>\n\n<Tab>\n\nAlpha\n\n</Tab>\n\n<Tab>\n\nBeta\n\n</Tab>\n\n</Tabs>",
    );
    expect(md).toBe('### Desktop app\n\nAlpha\n\n### Web app\n\nBeta');
  });

  test('panel headings sit above the headings inside the panels', () => {
    const md = serialize(
      "<Tabs items={['One']}>\n\n<Tab>\n\n### Inner\n\nBody\n\n</Tab>\n\n</Tabs>",
    );
    expect(md.startsWith('## One\n')).toBe(true);
  });

  test('an explicit panel value wins over its position in the items list', () => {
    const md = serialize(
      '<Tabs items={[\'Ignored\']}>\n\n<Tab value="Chosen">\n\nBody\n\n</Tab>\n\n</Tabs>',
    );
    expect(md).toContain('Chosen');
    expect(md).not.toContain('Ignored');
  });
});

describe('components whose content lives in their own module', () => {
  test('the download button lists every published build with its installer URL', () => {
    const md = serialize('<DownloadButton />');
    for (const target of DOWNLOAD_TARGETS) {
      expect(md).toContain(`[${target.label}](${target.assetUrl})`);
    }
  });

  test('the layer stack lists every layer with its role and description', () => {
    const md = serialize('<LayerStack />');
    for (const layer of LAYERS) {
      expect(md).toContain(layer.title);
      expect(md).toContain(layer.desc);
    }
  });

  test('the start paths render as absolute links', () => {
    const md = serialize('<WhereToStart />', 'https://openknowledge.ai/docs/get-started/overview');
    for (const path of PATHS) {
      expect(md).toContain(`[${path.title}](https://openknowledge.ai${path.href})`);
    }
  });

  test('the agent row lists every agent it advertises', () => {
    const md = serialize('<AgentIcons />');
    for (const agent of AGENTS) expect(md).toContain(agent.name);
  });

  test('the MCP install block names the editor it was given and keeps its guide link absolute', () => {
    const md = serialize('<McpInstall editor="Cursor" />');
    expect(md).toContain('two ways to connect Cursor');
    expect(md).toContain(
      '](https://openknowledge.ai/docs/get-started/quickstart#ok-install-web-app)',
    );
  });

  test('an MCP install block keeps the editor-specific notes nested inside it', () => {
    expect(serialize('<McpInstall editor="Hermes">\n\nRestart Hermes.\n\n</McpInstall>')).toContain(
      'Restart Hermes.',
    );
  });

  test('the verify block keeps the prompt and names the subject', () => {
    const md = serialize('<VerifyExec subject="Claude Code" />');
    expect(md).toContain('> List the first 5 documents you come across in this project.');
    expect(md).toContain('Claude Code should call the OpenKnowledge `exec` tool');
  });

  test('an editor name that reads as markup is neutralised before it lands in prose', () => {
    const md = serialize('<McpInstall editor="VS_Code <beta>" />');
    expect(md).toContain('two ways to connect VS\\_Code \\<beta>');
    expect(md).not.toContain('VS_Code');
  });

  test('a subject that spans lines still leaves the prompt as one blockquote', () => {
    const md = serialize('<VerifyExec subject="The\nagent" />');
    expect(md).toContain(
      '> List the first 5 documents you come across in this project.\n\nThe agent should call',
    );
  });
});

describe('containers and visual-only demos', () => {
  test('a preview wrapper contributes what its child component would', () => {
    expect(serialize('<ComponentPreview>\n\n<AgentIcons />\n\n</ComponentPreview>')).toContain(
      AGENTS[0].name,
    );
  });

  test('a media demo contributes nothing, because it has nothing to say in text', () => {
    expect(
      serialize('<ComponentPreview>\n\n<ImgPreview src="/a.png" alt="A" />\n\n</ComponentPreview>'),
    ).toBe('');
  });

  test('a card keeps the inline formatting in its description', () => {
    expect(serialize('<Card title="CLI" href="/docs/reference/cli">Run `ok init`.</Card>')).toBe(
      '- [CLI](https://openknowledge.ai/docs/reference/cli): Run `ok init`.',
    );
  });

  test('a card with a block body keeps its blocks instead of folding them onto one line', () => {
    const md = serialize(
      '<Card title="Setup">\n\nFirst do this.\n\n```bash\nok init\n```\n\n</Card>',
    );
    expect(md).toBe('**Setup**\n\nFirst do this.\n\n```bash\nok init\n```');
  });

  test('cards render as one list rather than one list per card', () => {
    const md = serialize(
      '<Cards>\n  <Card title="CLI" href="/docs/reference/cli">Command line.</Card>\n  <Card title="Config" href="/docs/reference/configuration">Settings.</Card>\n</Cards>',
    );
    expect(md).toBe(
      '- [CLI](https://openknowledge.ai/docs/reference/cli): Command line.\n' +
        '- [Config](https://openknowledge.ai/docs/reference/configuration): Settings.',
    );
  });
});

describe('the docs corpus through the real registry', () => {
  const withMdx = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
  const asMarkdown = unified().use(remarkParse).use(remarkGfm);

  let pages: CorpusPage[];
  const output = new Map<string, string>();

  beforeAll(async () => {
    pages = await readCorpus();
    for (const page of pages) {
      output.set(
        page.slug,
        serializeMdx(page.source, {
          registry: DOCS_SERIALIZER_REGISTRY,
          pageUrl: page.pageUrl,
        }).body,
      );
    }
  });

  test('every page serializes, so no component is left without a disposition', () => {
    expect(pages.length).toBeGreaterThan(50);
    expect(output.size).toBe(pages.length);
  });

  test('no page leaks a JSX element into the Markdown it serves', () => {
    const leaks: string[] = [];
    for (const [slug, md] of output) {
      visit(withMdx.parse(md), (node) => {
        if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
          leaks.push(`${slug}: <${node.name}>`);
        }
      });
    }
    expect(leaks).toEqual([]);
  });

  test('no page indents a code block to the four-space column', () => {
    const indented: string[] = [];
    for (const [slug, md] of output) {
      visit(asMarkdown.parse(md), 'code', (node) => {
        const opener = md[node.position?.start.offset ?? 0];
        if (opener !== '`' && opener !== '~') {
          indented.push(`${slug}: line ${node.position?.start.line}`);
        }
      });
    }
    expect(indented).toEqual([]);
  });

  test('no page carries a base64 component attribute', () => {
    for (const [slug, md] of output) {
      expect(md, slug).not.toContain('<HtmlPreview');
    }
  });

  test('the quickstart serves the download builds its CTA stands for', () => {
    const md = output.get('get-started/quickstart') ?? '';
    expect(md).toContain(DOWNLOAD_TARGETS[0].assetUrl);
    expect(md).toContain('### Install the desktop app');
  });

  test('every page embedding the shared install block serves its steps', () => {
    const embedding = pages.filter((page) => page.source.includes('<McpInstall'));
    expect(embedding.length).toBeGreaterThan(5);
    for (const page of embedding) {
      expect(output.get(page.slug), page.slug).toContain('depending on how you run OpenKnowledge');
    }
  });

  test('every page embedding the shared verification block serves its prompt', () => {
    const embedding = pages.filter((page) => page.source.includes('<VerifyExec'));
    expect(embedding.length).toBeGreaterThan(5);
    for (const page of embedding) {
      expect(output.get(page.slug), page.slug).toContain(
        '> List the first 5 documents you come across in this project.',
      );
    }
  });

  test('the overview serves the three layers and the start paths', () => {
    const md = output.get('get-started/overview') ?? '';
    for (const layer of LAYERS) expect(md).toContain(layer.desc);
    for (const path of PATHS) expect(md).toContain(path.desc);
    expect(md).toContain(AGENTS[0].name);
  });

  test('every authored preview fence survives as a fence, not as a base64 attribute', () => {
    const authored = pages.filter((page) => page.source.includes('```html preview'));
    expect(authored.length).toBeGreaterThan(5);
    for (const page of authored) {
      expect(output.get(page.slug), page.slug).toContain('```html preview');
    }
  });

  test('the mermaid page serves its diagram as a mermaid fence', () => {
    expect(output.get('reference/components/mermaid-fence') ?? '').toContain(
      '```mermaid\ngraph LR',
    );
  });

  test('every prop table on a component reference page survives as a table', () => {
    const withTypeTable = pages.filter((page) => page.source.includes('<TypeTable'));
    expect(withTypeTable.length).toBeGreaterThan(10);
    for (const page of withTypeTable) {
      expect(output.get(page.slug), page.slug).toContain('| Prop | Type | Required |');
    }
  });
});

describe('an attribute the author wrote as an expression', () => {
  test.each([
    ['<McpInstall editor={EDITOR} />', 'editor'],
    ['<VerifyExec subject={AGENT} />', 'subject'],
    ['<Callout title={TITLE}>body</Callout>', 'title'],
  ])('%s is refused rather than replaced by a fallback', (source, name) => {
    expect(() => serialize(source)).toThrow(new RegExp(`\`${name}\` is an expression`));
  });

  test('a bare attribute still reads as absent, since it carries no text', () => {
    expect(() =>
      serialize('<Tabs persist items={[{ title: "A", content: "b" }]} />'),
    ).not.toThrow();
  });
});
