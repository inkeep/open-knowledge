import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveWikiLinkTargetDocName } from '@inkeep/open-knowledge-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { matchWikiLinks } from './link-syntax.ts';
import { buildProjectWikiLinkLookup } from './project-wiki-link-lookup.ts';

const cases = [
  {
    name: 'moved target loses basename precedence',
    from: 'notes/beta',
    to: 'archive/beta-old',
    pages: { 'notes/beta': '# Beta\n', 'zzz/beta': '# Other\n', source: '[[beta#intro]]\n' },
    expected: { source: '[[archive/beta-old#intro|beta#intro]]\n' },
    targets: { source: ['archive/beta-old'] },
  },
  {
    name: 'new destination would steal an unmoved target',
    from: 'notes/beta',
    to: 'archive/beta',
    pages: { 'notes/beta': '# Moving\n', 'm/beta': '# Intended\n', source: '[[beta|Original]]\n' },
    expected: { source: '[[m/beta|Original]]\n' },
    targets: { source: ['m/beta'] },
  },
  {
    name: 'a suffix collision cannot redirect to an exact dotted identity',
    from: 'notes/beta',
    to: 'archive/beta',
    pages: {
      'notes/beta': '# Beta\n',
      'archive/beta.md': '# Dotted\n',
      source: '[[notes/beta.md]]\n',
    },
    expected: { source: '[[archive/beta|notes/beta.md]]\n' },
    targets: { source: ['archive/beta'] },
  },
  {
    name: 'folder batch preserves shorthand bytes and rewrites qualified links once',
    from: 'notes',
    to: 'archive',
    pages: {
      'notes/beta': '# Beta\n',
      'notes/gamma': '[[beta]]\n',
      source: '[[beta]] [[GAMMA.mdx|Gamma]] [[notes/beta#intro| Beta ]]\r\n',
      control: 'Unrelated bytes.\r\n',
    },
    expected: {
      source: '[[beta]] [[GAMMA.mdx|Gamma]] [[archive/beta#intro| Beta ]]\r\n',
      'archive/gamma': '[[beta]]\n',
      control: 'Unrelated bytes.\r\n',
    },
    targets: {
      source: ['archive/beta', 'archive/gamma', 'archive/beta'],
      'archive/gamma': ['archive/beta'],
      control: [],
    },
  },
] satisfies Array<{
  name: string;
  from: string;
  to: string;
  pages: Record<string, string>;
  expected: Record<string, string>;
  targets: Record<string, string[]>;
}>;

test.each(cases)(
  'managed MCP move: $name',
  async ({ from, to, pages, expected, targets }) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-mcp-rename-resolution-'));
    let booted: BootedServer | undefined;
    const client = new Client({ name: 'codex', version: '0.0.0-test' });
    try {
      for (const [name, body] of Object.entries(pages)) {
        const file = join(root, `${name}${name === 'notes/beta' ? '.mdx' : '.md'}`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
      }
      booted = await bootCompositionRig(root);
      await booted.ready;
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${booted.port}/mcp`)),
      );
      const connection = await booted.serverInstance.hocuspocus.openDirectConnection('source');
      try {
        const result = await client.callTool({ name: 'move', arguments: { from, to, cwd: root } });
        expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
        expect(existsSync(join(root, `${from}.md`))).toBe(false);
        expect(existsSync(join(root, `${from}.mdx`))).toBe(false);
        expect(existsSync(join(root, from))).toBe(false);
        const postPages = Object.keys(pages).map((page) =>
          page === from
            ? to
            : page.startsWith(`${from}/`)
              ? `${to}${page.slice(from.length)}`
              : page,
        );
        const lookup = buildProjectWikiLinkLookup(postPages);
        for (const [name, body] of Object.entries(expected)) {
          const actual = readFileSync(join(root, `${name}.md`), 'utf8');
          expect(actual, name).toBe(body);
          const actualTargets = actual
            .split(/\r?\n/)
            .flatMap(matchWikiLinks)
            .map((link) => resolveWikiLinkTargetDocName(link.target, lookup));
          expect(actualTargets, name).toEqual(targets[name]);
        }
        expect(connection.document.getText('source').toString()).toBe(expected.source);
        const dead = await client.callTool({
          name: 'links',
          arguments: { kind: 'dead', sourceDocuments: Object.keys(expected), cwd: root },
        });
        expect(dead.isError ?? false).toBe(false);
        expect(dead.structuredContent).toMatchObject({ deadLinks: [] });
      } finally {
        await connection.disconnect();
      }
    } finally {
      await client.close();
      await booted?.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
