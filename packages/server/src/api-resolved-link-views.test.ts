import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BacklinkCountsSuccessSchema,
  BacklinksSuccessSchema,
  ForwardLinksSuccessSchema,
  HubsSuccessSchema,
  LinkGraphSuccessSchema,
  OrphansSuccessSchema,
  SuggestLinksSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

async function get(booted: BootedServer, route: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${booted.port}${route}`);
  expect(response.status).toBe(200);
  return response.json();
}

test('HTTP, MCP and app-facing graph queries agree across a body edit, with a real ancestor hub advisory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-resolved-link-api-'));
  let booted: BootedServer | undefined;
  const client = new Client({ name: 'codex', version: '0.0.0-test' });
  try {
    for (const [doc, body] of Object.entries({
      'notes/INDEX': '# Notes\n',
      'notes/beta': '# Beta\n',
      'notes/gamma': '# Gamma\n',
      'notes/source': '[[BETA.md|Beta]]\n',
    })) {
      const file = join(root, `${doc}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
    booted = await bootCompositionRig(root);
    await booted.ready;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${booted.port}/mcp`)),
    );

    const verify = async (target: 'beta' | 'gamma') => {
      if (!booted) throw new Error('Server not booted');
      const canonical = `notes/${target}`;
      const previous = target === 'beta' ? 'notes/gamma' : 'notes/beta';
      const backlinks = BacklinksSuccessSchema.parse(
        await get(booted, `/api/backlinks?docName=${canonical}`),
      );
      expect(backlinks.backlinks.map((entry) => entry.source)).toEqual(['notes/source']);
      const counts = BacklinkCountsSuccessSchema.parse(
        await get(booted, '/api/backlink-counts?docNames=notes/beta,notes/gamma'),
      );
      expect(counts.counts).toEqual({ [canonical]: 1, [previous]: 0 });
      const forward = ForwardLinksSuccessSchema.parse(
        await get(booted, '/api/forward-links?docName=notes/source'),
      );
      expect(forward.forwardLinks).toEqual([
        expect.objectContaining({ kind: 'doc', docName: canonical }),
      ]);
      const orphans = OrphansSuccessSchema.parse(await get(booted, '/api/orphans?mode=incoming'));
      expect(orphans.orphans.map((entry) => entry.docName)).not.toContain(canonical);
      expect(orphans.orphans.map((entry) => entry.docName)).toContain(previous);
      const hubs = HubsSuccessSchema.parse(await get(booted, '/api/hubs'));
      expect(hubs.hubs).toContainEqual(expect.objectContaining({ docName: canonical, count: 1 }));
      const graph = LinkGraphSuccessSchema.parse(await get(booted, '/api/link-graph'));
      expect(graph.links).toContainEqual({ source: 'notes/source', target: canonical });
      expect(graph.links).not.toContainEqual({ source: 'notes/source', target: previous });
      const suggestions = SuggestLinksSuccessSchema.parse(
        await get(booted, `/api/suggest-links?docName=${canonical}`),
      );
      expect(suggestions.mentions).toEqual([]);
      const mcp = await client.callTool({
        name: 'links',
        arguments: {
          kind: ['backlinks', 'hubs', 'orphans', 'suggest'],
          mode: 'incoming',
          document: canonical,
          cwd: root,
        },
      });
      expect(mcp.isError ?? false).toBe(false);
      expect(mcp.structuredContent).toMatchObject({
        backlinks: [expect.objectContaining({ source: 'notes/source' })],
        hubs: expect.arrayContaining([expect.objectContaining({ docName: canonical, count: 1 })]),
        suggest: { mentions: [] },
      });
      const mcpForward = await client.callTool({
        name: 'links',
        arguments: { kind: 'forward', document: 'notes/source', cwd: root },
      });
      expect(mcpForward.isError ?? false).toBe(false);
      expect(mcpForward.structuredContent).toMatchObject({
        forwardLinks: [expect.objectContaining({ kind: 'doc', docName: canonical })],
      });
    };

    await verify('beta');
    const linkedWrite = await client.callTool({
      name: 'write',
      arguments: {
        document: { path: 'notes/beta', content: '\nUpdated.\n', position: 'append' },
        cwd: root,
      },
    });
    expect(linkedWrite.isError ?? false).toBe(false);
    expect(linkedWrite.structuredContent).toMatchObject({ document: expect.any(Object) });
    expect(JSON.stringify(linkedWrite.structuredContent)).not.toContain('no backlinks yet');
    const unlinkedWrite = await client.callTool({
      name: 'write',
      arguments: {
        document: { path: 'notes/gamma', content: '\nUpdated.\n', position: 'append' },
        cwd: root,
      },
    });
    expect(unlinkedWrite.isError ?? false).toBe(false);
    expect(unlinkedWrite.structuredContent).toMatchObject({
      document: {
        hints: [expect.objectContaining({ type: 'orphan', parentCandidates: ['notes/INDEX'] })],
      },
    });
    const edit = await client.callTool({
      name: 'edit',
      arguments: {
        document: {
          path: 'notes/source',
          find: '[[BETA.md|Beta]]',
          replace: '[[gamma.mdx|Gamma]]',
        },
        cwd: root,
      },
    });
    expect(edit.isError ?? false).toBe(false);
    await verify('gamma');
  } finally {
    await client.close();
    await booted?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
