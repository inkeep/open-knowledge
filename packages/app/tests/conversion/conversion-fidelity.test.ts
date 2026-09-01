import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from '../integration/harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
  createTestServer,
  mdManager,
  pollUntil,
  readTestDoc,
  schema,
  serializeFragment,
  stripTrailingWhitespace,
  type TestServer,
  testReset,
} from '../integration/test-harness';

function mdRoundTrip(md: string): string {
  const json = mdManager.parse(md);
  return mdManager.serialize(json);
}

function treeRoundTrip(md: string): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, fragment, pmNode, meta);
  const resultJson = yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON();
  const result = mdManager.serialize(resultJson);
  doc.destroy();
  return result;
}

const CONSTRUCTS: Array<{ name: string; input: string; stable?: boolean; note?: string }> = [
  {
    name: 'heading (h1)',
    input: '# Heading 1\n',
    stable: true,
  },
  {
    name: 'heading (h2)',
    input: '## Heading 2\n',
    stable: true,
  },
  {
    name: 'heading (h3)',
    input: '### Heading 3\n',
    stable: true,
  },
  {
    name: 'paragraph',
    input: 'A simple paragraph.\n',
    stable: true,
  },
  {
    name: 'heading + paragraph',
    input: '## Heading\n\nA paragraph after heading.\n',
    stable: true,
  },
  {
    name: 'bullet list',
    input: '* Item 1\n* Item 2\n* Item 3\n',
  },
  {
    name: 'numbered list',
    input: '1. First\n2. Second\n3. Third\n',
  },
  {
    name: 'fenced code block',
    input: '```javascript\nconst x = 1;\n```\n',
  },
  {
    name: 'inline marks: bold',
    input: 'This is **bold** text.\n',
    stable: true,
  },
  {
    name: 'inline marks: italic',
    input: 'This is *italic* text.\n',
    stable: true,
  },
  {
    name: 'inline marks: code',
    input: 'This has `inline code` here.\n',
    stable: true,
  },
  {
    name: 'inline marks: strikethrough',
    input: 'This is ~~struck~~ text.\n',
  },
  {
    name: 'link',
    input: 'Visit [example](https://example.com) for more.\n',
    stable: true,
  },
  {
    name: 'wikilink: bare',
    input: 'Alpha [[Page]]\n',
    stable: true,
  },
  {
    name: 'wikilink: alias',
    input: 'Beta [[Page|Alias]]\n',
    stable: true,
  },
  {
    name: 'wikilink: section',
    input: 'Gamma [[Page#Heading]]\n',
    stable: true,
  },
  {
    name: 'wikilink: section alias',
    input: 'Delta [[Page#Heading|Alias]]\n',
    stable: true,
  },
  {
    name: 'image',
    input: '![Alt text](https://example.com/img.png)\n',
  },
  {
    name: 'image preserves block separators between siblings',
    input: '# Heading\n\n![alt](img.png)\n\n## Next\n\nPara text.\n',
    stable: true,
    note: 'Regression: image as PM block used to collapse adjacent block separators',
  },
  {
    name: 'image inline within paragraph text',
    input: 'Before ![alt](img.png) after.\n',
    stable: true,
  },
  {
    name: 'blockquote',
    input: '> This is a blockquote.\n',
  },
  {
    name: 'horizontal rule',
    input: '---\n',
  },
  {
    name: 'hard line break',
    input: 'Line one  \nLine two\n',
    note: 'Two trailing spaces create hard break',
  },
  {
    name: 'nested list',
    input: '* Item 1\n  * Nested 1\n  * Nested 2\n* Item 2\n',
  },
];

describe('markdown round-trip: serialize(parse(md))', () => {
  for (const { name, input, stable } of CONSTRUCTS) {
    test.concurrent(name, () => {
      const output = stripTrailingWhitespace(mdRoundTrip(input));
      const normalized = stripTrailingWhitespace(input);

      if (stable) {
        expect(output).toBe(normalized);
      } else {
        const tokens = normalized.match(/[\w&<>]+/g) ?? [];
        for (const token of tokens) {
          expect(output).toContain(token);
        }
      }
    });
  }
});

describe('tree round-trip: pmJSON → updateYFragment → yXmlFragmentToProsemirrorJSON → serialize', () => {
  for (const { name, input } of CONSTRUCTS) {
    test.concurrent(name, () => {
      const output = stripTrailingWhitespace(treeRoundTrip(input));
      const normalized = stripTrailingWhitespace(input);

      const tokens = normalized.match(/[\w&<>]+/g) ?? [];
      for (const token of tokens) {
        expect(output).toContain(token);
      }
    });
  }
});

const MARKED_INLINE_LEAF: Array<{ name: string; input: string; expected: string }> = [
  { name: 'strong + wikilink', input: '**[[Page]]**\n', expected: '**[[Page]]**\n' },
  {
    name: 'strong + wikilink with alias',
    input: '**[[Page|Alias]]**\n',
    expected: '**[[Page|Alias]]**\n',
  },
  {
    name: 'strong + wikilink with anchor',
    input: '**[[Page#Section]]**\n',
    expected: '**[[Page#Section]]**\n',
  },
  { name: 'emphasis + wikilink', input: '*[[Page]]*\n', expected: '*[[Page]]*\n' },
  { name: 'strikethrough + wikilink', input: '~~[[Page]]~~\n', expected: '~~[[Page]]~~\n' },

  {
    name: 'strong + emphasis + wikilink',
    input: '***[[Page]]***\n',
    expected: '***[[Page]]***\n',
  },
  {
    name: 'strong + strikethrough + wikilink',
    input: '**~~[[Page]]~~**\n',
    expected: '**~~[[Page]]~~**\n',
  },
  { name: 'strong + emphasis + tag', input: '***#mytag***\n', expected: '***#mytag***\n' },
  {
    name: 'strong + wikilink mid-paragraph',
    input: 'lead **[[Page]]** trail\n',
    expected: 'lead **[[Page]]** trail\n',
  },
  { name: 'strong + image', input: '**![alt](file.png)**\n', expected: '**![alt](file.png)**\n' },
  { name: 'strong + inline math', input: '**$x = 1$**\n', expected: '**$x = 1$**\n' },
  { name: 'strong + tag', input: '**#mytag**\n', expected: '**#mytag**\n' },
  {
    name: 'strong + hard break (backslash)',
    input: '**alpha\\\nbravo**\n',
    expected: '**alpha\\\nbravo**\n',
  },
  {
    name: 'strong + hard break (two spaces)',
    input: '**alpha  \nbravo**\n',
    expected: '**alpha  \nbravo**\n',
  },
  {
    name: 'strong + image reference',
    input: '**![alt][ref]**\n\n[ref]: file.png\n',
    expected: '**![alt][ref]**\n\n[ref]: file.png\n',
  },
  {
    name: 'strong + footnote reference',
    input: '**[^1]**\n\n[^1]: a note\n',
    expected: '**[^1]**\n\n[^1]: a note\n',
  },
  { name: 'strong + inline JSX', input: '**<Icon />**\n', expected: '**<Icon />**\n' },

  {
    name: 'control: strong + inline link',
    input: '**[a](https://example.com)**\n',
    expected: '**[a](https://example.com)**\n',
  },
  { name: 'control: strong + empty wikilink', input: '**[[]]**\n', expected: '**[[]]**\n' },
  {
    name: 'control: strong + inline wiki embed',
    input: '**![[embed.png]]**\n',
    expected: '**![[embed.png]]**\n',
  },
  { name: 'control: bare wikilink', input: '[[Page]]\n', expected: '[[Page]]\n' },
  { name: 'control: strong on text', input: '**alpha**\n', expected: '**alpha**\n' },
  { name: 'control: bare image', input: '![alt](file.png)\n', expected: '![alt](file.png)\n' },
  { name: 'control: bare inline math', input: '$x = 1$\n', expected: '$x = 1$\n' },
  { name: 'control: bare tag', input: '#mytag is here\n', expected: '#mytag is here\n' },
  { name: 'control: bare inline JSX', input: '<Icon />\n', expected: '<Icon />\n' },
  { name: 'control: bare hard break', input: 'alpha\\\nbravo\n', expected: 'alpha\\\nbravo\n' },
  {
    name: 'control: bare image reference',
    input: '![alt][ref]\n\n[ref]: file.png\n',
    expected: '![alt][ref]\n\n[ref]: file.png\n',
  },
  {
    name: 'control: bare footnote reference',
    input: '[^1]\n\n[^1]: a note\n',
    expected: '[^1]\n\n[^1]: a note\n',
  },
  {
    name: 'control: non-flanking delimiter run',
    input: '** [[Page]]**\n',
    expected: '\\*\\* [[Page]]\\*\\*\n',
  },
  {
    name: 'control: mismatched delimiters',
    input: '**[[Page]]__\n',
    expected: '\\*\\*[[Page]]\\_\\_\n',
  },
];

describe('marked inline leaf nodes: byte-exact through chains 1 and 2', () => {
  for (const { name, input, expected } of MARKED_INLINE_LEAF) {
    test.concurrent(name, () => {
      expect(mdRoundTrip(input)).toBe(expected);
      expect(treeRoundTrip(input)).toBe(expected);
    });
  }
});

describe('marked inline leaf nodes: in-place fragment update', () => {
  test('a reused fragment gains, keeps and loses a mark on an inline leaf', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const meta = { mapping: new Map(), isOMark: new Map() };

    const applyMd = (md: string): string => {
      updateYFragment(doc, fragment, schema.nodeFromJSON(mdManager.parse(md)), meta);
      return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
    };

    try {
      expect(applyMd('[[Page]]\n\nsibling\n')).toBe('[[Page]]\n\nsibling\n');
      expect(applyMd('**[[Page]]**\n\nsibling\n')).toBe('**[[Page]]**\n\nsibling\n');
      expect(applyMd('**[[Page]]**\n\nsibling edited\n')).toBe('**[[Page]]**\n\nsibling edited\n');
      expect(applyMd('**[[Other]]**\n\nsibling edited\n')).toBe(
        '**[[Other]]**\n\nsibling edited\n',
      );
      expect(applyMd('[[Other]]\n\nsibling edited\n')).toBe('[[Other]]\n\nsibling edited\n');
    } finally {
      doc.destroy();
    }
  });
});

describe('disk round-trip: XmlFragment → persistence → disk → onLoadDocument → XmlFragment', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  const DISK_CONSTRUCTS = CONSTRUCTS.filter((c) => !['hard line break'].includes(c.name));

  for (const { name, input } of DISK_CONSTRUCTS) {
    test(name, async () => {
      await testReset(server.port);
      await wait(300);

      const client = await createTestClient(server.port, 'test-doc');
      try {
        const json = mdManager.parse(input);
        const pmNode = schema.nodeFromJSON(json);
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(client.doc, client.fragment, pmNode, meta);

        const tokens = stripTrailingWhitespace(input).match(/[\w&<>]+/g) ?? [];
        if (tokens.length > 0) {
          await pollUntil(
            () => tokens.every((t) => readTestDoc(server.contentDir).includes(t)),
            5000,
          );
        }

        const diskContent = readTestDoc(server.contentDir);
        for (const token of tokens) {
          expect(diskContent).toContain(token);
        }
      } finally {
        await client.cleanup();
      }

      await testReset(server.port);
      await wait(300);
      writeFileSync(join(server.contentDir, 'test-doc.md'), input, 'utf-8');

      const client2 = await createTestClient(server.port, 'test-doc');
      try {
        const tokens = stripTrailingWhitespace(input).match(/[\w&<>]+/g) ?? [];
        if (tokens.length > 0) {
          await pollUntil(() => tokens.every((t) => client2.ytext.toString().includes(t)), 5000);
        }

        for (const token of tokens) {
          expect(client2.ytext.toString()).toContain(token);
        }
        assertBridgeInvariant(client2.ytext, client2.fragment);
      } finally {
        await client2.cleanup();
      }
    });
  }
});

describe('agent-as-file-editor fidelity', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test('complex markdown written to disk → all 3 surfaces → user types → coexistence', async () => {
    const complexMd = [
      '# Agent File Edit',
      '',
      'Paragraph with **bold** and *italic* and `code`.',
      '',
      '## Section Two',
      '',
      '* Bullet one',
      '* Bullet two',
      '',
      '1. Numbered one',
      '2. Numbered two',
      '',
      '```javascript',
      'const x = 42;',
      '```',
      '',
      '> A blockquote.',
      '',
      '---',
      '',
      'Final paragraph.',
      '',
    ].join('\n');

    await testReset(server.port);
    await wait(300);

    writeFileSync(join(server.contentDir, 'test-doc.md'), complexMd, 'utf-8');

    await wait(500);
    const client = await createTestClient(server.port, 'test-doc');
    try {
      await pollUntil(() => client.ytext.toString().includes('Agent File Edit'), 10_000);

      expect(client.ytext.toString()).toContain('Section Two');
      expect(client.ytext.toString()).toContain('Bullet one');
      expect(serializeFragment(client.fragment)).toContain('Agent File Edit');
      const diskContent = readTestDoc(server.contentDir);
      expect(diskContent).toContain('Agent File Edit');

      assertBridgeInvariant(client.ytext, client.fragment);

      const userJson = mdManager.parse('## User Section\n\nUser typed this.');
      const userNode = schema.nodeFromJSON(userJson);
      client.doc.transact(() => {
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(client.doc, client.fragment, userNode, meta);
      });

      await pollUntil(() => {
        const t = stripTrailingWhitespace(client.ytext.toString());
        const f = stripTrailingWhitespace(serializeFragment(client.fragment));
        return t === f && t.length > 0;
      }, 5000);

      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('agent writes via API + user writes coexist', async () => {
    await testReset(server.port);
    await wait(300);

    const client = await createTestClient(server.port, 'test-doc');
    try {
      client.doc.transact(() => {
        client.ytext.insert(0, '# User Content\n\nTyped by user.');
      });
      await pollUntil(() => serializeFragment(client.fragment).includes('User Content'), 5000);

      await agentWriteMd(server.port, '## Agent Content\n\nWritten by agent.', {
        docName: 'test-doc',
      });
      await pollUntil(() => client.ytext.toString().includes('Agent Content'), 5000);

      expect(client.ytext.toString()).toContain('User Content');
      expect(client.ytext.toString()).toContain('Agent Content');

      assertBridgeInvariant(client.ytext, client.fragment);

      await pollUntil(() => {
        const disk = readTestDoc(server.contentDir);
        return disk.includes('User Content') && disk.includes('Agent Content');
      }, 5000);
    } finally {
      await client.cleanup();
    }
  });
});
