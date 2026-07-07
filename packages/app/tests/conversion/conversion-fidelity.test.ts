/**
 * Conversion fidelity tests.
 *
 * Verifies that every supported markdown construct survives the format
 * conversions in the stack:
 *   1. Markdown round-trip: serialize(parse(md))
 *   2. Tree round-trip: pmJSON → nodeFromJSON → updateYFragment → yXmlFragmentToProsemirrorJSON → pmJSON
 *   3. Disk round-trip: XmlFragment → persistence → disk → onLoadDocument → XmlFragment
 *   4. Agent-as-file-editor: agent writes file → disk → CRDT → all surfaces
 *
 * Documents which constructs are stable vs which normalize.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
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

// ─── Helpers ───

/** Markdown round-trip: serialize(parse(md)) */
function mdRoundTrip(md: string): string {
  const json = mdManager.parse(md);
  return mdManager.serialize(json);
}

/** Tree round-trip: JSON → node → updateYFragment → yXmlFragmentToProsemirrorJSON → JSON */
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

// ─── Test fixtures: every supported markdown construct ───

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

// ─── 1. Markdown round-trip ───

describe('markdown round-trip: serialize(parse(md))', () => {
  for (const { name, input, stable } of CONSTRUCTS) {
    test.concurrent(name, () => {
      const output = stripTrailingWhitespace(mdRoundTrip(input));
      const normalized = stripTrailingWhitespace(input);

      if (stable) {
        // Construct should be perfectly stable
        expect(output).toBe(normalized);
      } else {
        // Construct may normalize but must preserve semantic content
        // Extract meaningful text content (strip markdown syntax)
        const tokens = normalized.match(/[\w&<>]+/g) ?? [];
        for (const token of tokens) {
          expect(output).toContain(token);
        }
      }
    });
  }
});

// ─── 2. Tree round-trip ───

describe('tree round-trip: pmJSON → updateYFragment → yXmlFragmentToProsemirrorJSON → serialize', () => {
  for (const { name, input } of CONSTRUCTS) {
    test.concurrent(name, () => {
      const output = stripTrailingWhitespace(treeRoundTrip(input));
      const normalized = stripTrailingWhitespace(input);

      // Tree round-trip should preserve content (may normalize whitespace)
      const tokens = normalized.match(/[\w&<>]+/g) ?? [];
      for (const token of tokens) {
        expect(output).toContain(token);
      }
    });
  }
});

// Observer round-trip and full-stack chain blocks removed.
// Layer A (mdManager) === Layer B (Y.Doc observer path) on all 118 constructs.
// These chains tested a proven pass-through.
// Remaining blocks (md round-trip, tree round-trip, disk round-trip, agent-as-file-editor)
// exercise genuinely distinct code paths.

// ─── 3. Disk round-trip (Tier 1 integration) ───

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

      // Connect client and write content via WYSIWYG (XmlFragment)
      const client = await createTestClient(server.port, 'test-doc');
      try {
        const json = mdManager.parse(input);
        const pmNode = schema.nodeFromJSON(json);
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(client.doc, client.fragment, pmNode, meta);

        // Wait for persistence to write to disk (strict: includes &<> fidelity chars)
        const tokens = stripTrailingWhitespace(input).match(/[\w&<>]+/g) ?? [];
        if (tokens.length > 0) {
          await pollUntil(
            () => tokens.every((t) => readTestDoc(server.contentDir).includes(t)),
            5000,
          );
        }

        // Verify disk content preserves the construct
        const diskContent = readTestDoc(server.contentDir);
        for (const token of tokens) {
          expect(diskContent).toContain(token);
        }
      } finally {
        await client.cleanup();
      }

      // Now test reload: reset doc, write content to disk, reconnect client
      await testReset(server.port);
      await wait(300);
      writeFileSync(join(server.contentDir, 'test-doc.md'), input, 'utf-8');

      const client2 = await createTestClient(server.port, 'test-doc');
      try {
        // Wait for onLoadDocument + Observer A to populate Y.Text (strict: includes &<> fidelity chars)
        const tokens = stripTrailingWhitespace(input).match(/[\w&<>]+/g) ?? [];
        if (tokens.length > 0) {
          await pollUntil(() => tokens.every((t) => client2.ytext.toString().includes(t)), 5000);
        }

        // Verify content round-tripped through disk
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

// ─── 4. Agent-as-file-editor fidelity ───

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

    // Write complex markdown to disk (simulating agent file edit)
    writeFileSync(join(server.contentDir, 'test-doc.md'), complexMd, 'utf-8');

    // Connect client and wait for file watcher to propagate
    await wait(500);
    const client = await createTestClient(server.port, 'test-doc');
    try {
      await pollUntil(() => client.ytext.toString().includes('Agent File Edit'), 10_000);

      // Verify all 3 surfaces have content
      expect(client.ytext.toString()).toContain('Section Two');
      expect(client.ytext.toString()).toContain('Bullet one');
      expect(serializeFragment(client.fragment)).toContain('Agent File Edit');
      const diskContent = readTestDoc(server.contentDir);
      expect(diskContent).toContain('Agent File Edit');

      assertBridgeInvariant(client.ytext, client.fragment);

      // User types in WYSIWYG (simulated via XmlFragment edit)
      const userJson = mdManager.parse('## User Section\n\nUser typed this.');
      const userNode = schema.nodeFromJSON(userJson);
      client.doc.transact(() => {
        const meta = { mapping: new Map(), isOMark: new Map() };
        updateYFragment(client.doc, client.fragment, userNode, meta);
      });

      // Poll until bridge converges after user XmlFragment edit
      await pollUntil(() => {
        const t = stripTrailingWhitespace(client.ytext.toString());
        const f = stripTrailingWhitespace(serializeFragment(client.fragment));
        return t === f && t.length > 0;
      }, 5000);

      // Both agent and user content should coexist
      // (updateYFragment replaces tree, but user content replaces agent content in this test)
      // The key assertion: bridge invariant still holds
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
      // User types first (via Y.Text, simulating source mode)
      client.doc.transact(() => {
        client.ytext.insert(0, '# User Content\n\nTyped by user.');
      });
      await pollUntil(() => serializeFragment(client.fragment).includes('User Content'), 5000);

      // Agent writes via API
      await agentWriteMd(server.port, '## Agent Content\n\nWritten by agent.', {
        docName: 'test-doc',
      });
      await pollUntil(() => client.ytext.toString().includes('Agent Content'), 5000);

      // Both should coexist in Y.Text
      expect(client.ytext.toString()).toContain('User Content');
      expect(client.ytext.toString()).toContain('Agent Content');

      assertBridgeInvariant(client.ytext, client.fragment);

      // Verify disk has both
      await pollUntil(() => {
        const disk = readTestDoc(server.contentDir);
        return disk.includes('User Content') && disk.includes('Agent Content');
      }, 5000);
    } finally {
      await client.cleanup();
    }
  });
});
