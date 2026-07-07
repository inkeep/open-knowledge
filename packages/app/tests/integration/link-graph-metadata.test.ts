/**
 * Integration test: /api/link-graph returns frontmatter metadata (cluster, category, tags)
 * on doc nodes when present.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

interface LinkGraphResponse {
  nodes: Array<{
    id: string;
    kind: 'doc' | 'external';
    docName?: string;
    label: string;
    cluster?: string | null;
    category?: string | null;
    tags?: string[] | null;
    url?: string;
  }>;
  links: Array<{ source: string; target: string }>;
}

let server: TestServer;

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-linkgraph-meta-')));

  writeFileSync(
    join(contentDir, 'hub.md'),
    '---\ntitle: Hub Page\ncluster: retrieval\ncategory: concept\ntags: [search, vectors]\n---\n\n# Hub\n\nLinks to [[spoke-a]] and [[spoke-b]].\n',
    'utf-8',
  );
  writeFileSync(
    join(contentDir, 'spoke-a.md'),
    '---\ntitle: Spoke A\ncluster: retrieval\ncategory: method\ntags: [dense, embedding]\n---\n\n# Spoke A\n\nLinks to [[hub]].\n',
    'utf-8',
  );
  writeFileSync(
    join(contentDir, 'spoke-b.md'),
    '---\ntitle: Spoke B\ncluster: planning\ncategory: tool\n---\n\n# Spoke B\n\nLinks to [[hub]].\n',
    'utf-8',
  );
  writeFileSync(
    join(contentDir, 'no-frontmatter.md'),
    '# No Frontmatter\n\nLinks to [[hub]].\n',
    'utf-8',
  );

  server = await createTestServer({ contentDir, keepContentDir: true });
  await wait(1500);
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function fetchLinkGraph(): Promise<LinkGraphResponse> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/link-graph`);
  return res.json() as Promise<LinkGraphResponse>;
}

describe('/api/link-graph metadata enrichment', () => {
  test('doc nodes include cluster, category, tags from frontmatter', async () => {
    const data = await fetchLinkGraph();
    expect(Array.isArray(data.nodes)).toBe(true);

    const hubNode = data.nodes.find((n) => n.kind === 'doc' && n.docName === 'hub');
    expect(hubNode).toBeDefined();
    expect(hubNode?.cluster).toBe('retrieval');
    expect(hubNode?.category).toBe('concept');
    expect(hubNode?.tags).toEqual(['search', 'vectors']);

    const spokeA = data.nodes.find((n) => n.kind === 'doc' && n.docName === 'spoke-a');
    expect(spokeA).toBeDefined();
    expect(spokeA?.cluster).toBe('retrieval');
    expect(spokeA?.category).toBe('method');
    expect(spokeA?.tags).toEqual(['dense', 'embedding']);
  });

  test('doc nodes without tags return null for tags', async () => {
    const data = await fetchLinkGraph();

    const spokeB = data.nodes.find((n) => n.kind === 'doc' && n.docName === 'spoke-b');
    expect(spokeB).toBeDefined();
    expect(spokeB?.cluster).toBe('planning');
    expect(spokeB?.category).toBe('tool');
    expect(spokeB?.tags).toBeNull();
  });

  test('doc nodes without frontmatter return null for all metadata fields', async () => {
    const data = await fetchLinkGraph();

    const noFm = data.nodes.find((n) => n.kind === 'doc' && n.docName === 'no-frontmatter');
    expect(noFm).toBeDefined();
    expect(noFm?.cluster).toBeNull();
    expect(noFm?.category).toBeNull();
    expect(noFm?.tags).toBeNull();
  });

  test('external nodes do not have metadata fields', async () => {
    const data = await fetchLinkGraph();

    const externals = data.nodes.filter((n) => n.kind === 'external');
    for (const ext of externals) {
      expect(ext.cluster).toBeUndefined();
      expect(ext.category).toBeUndefined();
      expect(ext.tags).toBeUndefined();
    }
  });

  test('multiple distinct cluster values in response', async () => {
    const data = await fetchLinkGraph();

    const clusters = new Set(
      data.nodes.filter((n) => n.kind === 'doc' && n.cluster).map((n) => n.cluster),
    );
    expect(clusters.size).toBeGreaterThanOrEqual(2);
  });
});
