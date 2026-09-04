import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestServer, type TestServer } from './test-harness.ts';

describe('global skill bundle graph participation', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });
  const base = () => `http://127.0.0.1:${server.port}`;

  async function putGlobalSkill(name: string, body: string): Promise<void> {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        scope: 'global',
        body,
        frontmatter: { name, description: 'a global skill with bundle refs' },
      }),
    });
    if (!res.ok) throw new Error(`global skill PUT failed: ${res.status} ${await res.text()}`);
  }

  async function putGlobalSkillFile(name: string, path: string, content: string): Promise<void> {
    const res = await fetch(`${base()}/api/skill-file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: 'global', path, content }),
    });
    if (!res.ok) throw new Error(`global skill-file PUT failed: ${res.status} ${await res.text()}`);
  }

  async function rescan(): Promise<void> {
    const res = await fetch(`${base()}/api/test-rescan-backlinks`, { method: 'POST' });
    if (!res.ok) throw new Error(`rescan failed: ${res.status} ${await res.text()}`);
  }

  async function fullGraph(): Promise<{
    nodes: Array<{ id: string }>;
    links: Array<{ source: string; target: string }>;
  }> {
    const res = await fetch(`${base()}/api/link-graph`);
    const data = (await res.json()) as {
      nodes?: Array<{ id: string }>;
      links?: Array<{ source: string; target: string }>;
    };
    return { nodes: data.nodes ?? [], links: data.links ?? [] };
  }

  async function backlinkSources(target: string): Promise<string[]> {
    const res = await fetch(`${base()}/api/backlinks?docName=${encodeURIComponent(target)}`);
    const data = (await res.json()) as { backlinks?: Array<{ source: string }> };
    return Array.isArray(data.backlinks) ? data.backlinks.map((b) => b.source) : [];
  }

  test('a global SKILL connects to its references and never into the project KB', async () => {
    const skillNode = '__skill__/global/demo/references/notes';
    const skillDoc = '__skill__/global/demo';

    const seed = await fetch(`${base()}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: 'architecture',
        markdown: '# Architecture\n',
        position: 'replace',
      }),
    });
    expect(seed.ok).toBe(true);

    await putGlobalSkill('demo', '# Demo\n\nDetails in `references/notes.md`.\n');
    await putGlobalSkillFile('demo', 'references/notes.md', '# Notes\n\nSee [[architecture]].\n');
    await rescan();

    const graph = await fullGraph();
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has(skillDoc)).toBe(true);
    expect(ids.has(skillNode)).toBe(true);
    expect(graph.links).toEqual(expect.arrayContaining([{ source: skillDoc, target: skillNode }]));

    expect(graph.links).not.toEqual(
      expect.arrayContaining([{ source: skillNode, target: 'architecture' }]),
    );
    expect(await backlinkSources('architecture')).not.toContain(skillNode);
  }, 20000);
});
