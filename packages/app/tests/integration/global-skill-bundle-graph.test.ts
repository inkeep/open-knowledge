import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestServer, type TestServer } from './test-harness.ts';

/**
 * GLOBAL skill bundle participation in the link graph.
 *
 * A global skill lives at `<home>/.ok/skills/<name>/`, OUTSIDE the project
 * content dir, so its bundle docs are NOT content docs — they keep the
 * managed-artifact namespace (`__skill__/global/<name>` + `/references/<rel>`).
 * They participate via structural (name-derived) within-bundle edges ONLY: a
 * global SKILL connects to its OWN references and never links into the project's
 * KB. The cluster appears in EVERY project's graph (global skills are available
 * everywhere) — proven here by the cluster surfacing in this project's graph
 * even though it lives under the (isolated test) user home, not contentDir.
 */
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

  /** Force a deterministic resync (covers the polling watcher's latency). */
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

    // A real project doc the global reference body deliberately "links" to — the
    // within-bundle guard must drop that cross-boundary edge.
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

    // The SKILL must exist before a bundle file can be added; the reference then
    // lands on disk. The forced rescan re-ingests the whole bundle from disk.
    await putGlobalSkill('demo', '# Demo\n\nDetails in `references/notes.md`.\n');
    await putGlobalSkillFile('demo', 'references/notes.md', '# Notes\n\nSee [[architecture]].\n');
    await rescan();

    const graph = await fullGraph();
    const ids = new Set(graph.nodes.map((n) => n.id));
    // Cross-project visibility: the global cluster appears in THIS project's graph
    // even though it lives under the user home, not contentDir.
    expect(ids.has(skillDoc)).toBe(true);
    expect(ids.has(skillNode)).toBe(true);
    // Within-bundle structural edge SKILL ↔ reference.
    expect(graph.links).toEqual(expect.arrayContaining([{ source: skillDoc, target: skillNode }]));

    // NEGATIVE CONTROL: the reference's `[[architecture]]` body link must NOT
    // create a cross-boundary edge into the project KB.
    expect(graph.links).not.toEqual(
      expect.arrayContaining([{ source: skillNode, target: 'architecture' }]),
    );
    expect(await backlinkSources('architecture')).not.toContain(skillNode);
  }, 20000);
});
