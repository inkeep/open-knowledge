import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestServer, pollUntil, type TestServer } from './test-harness.ts';

/**
 * INBOUND link from a skill's SKILL.md to one of its bundle references.
 *
 * The sibling `skill-bundle-files.test.ts` proves the OUTBOUND direction (a
 * reference's `[[top-level-doc]]` resolves). This proves the inbound case the
 * user hit: a SKILL.md authored with the natural bundle-relative wiki-link
 * `[[references/<x>]]` (and the markdown-link form) must create a backlink on
 * the bundle reference content doc through the LIVE derived-index path — no
 * test-only rescan route. A bundle-relative wiki-link used to classify as a
 * bare content-root doc name (`references/<x>` at the root) and silently miss
 * the ref, leaving it orphaned with 0 backlinks in the graph.
 */
describe('skill SKILL.md → references/<x> inbound backlink (live index)', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });
  const base = () => `http://127.0.0.1:${server.port}`;

  async function putSkill(name: string, body: string): Promise<void> {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        scope: 'project',
        body,
        frontmatter: { name, description: 'a skill with bundle refs' },
      }),
    });
    if (!res.ok) throw new Error(`skill PUT failed: ${res.status} ${await res.text()}`);
  }
  async function putSkillFile(name: string, path: string, content: string) {
    return fetch(`${base()}/api/skill-file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: 'project', path, content }),
    });
  }
  async function backlinkSources(target: string): Promise<string[]> {
    const res = await fetch(`${base()}/api/backlinks?docName=${encodeURIComponent(target)}`);
    const data = (await res.json()) as { backlinks?: Array<{ source: string }> };
    return Array.isArray(data.backlinks) ? data.backlinks.map((b) => b.source) : [];
  }

  async function graphNeighborhood(
    docName: string,
  ): Promise<{ nodes: Array<{ id: string }>; links: Array<{ source: string; target: string }> }> {
    const res = await fetch(
      `${base()}/api/link-graph?docName=${encodeURIComponent(docName)}&degrees=1`,
    );
    const data = (await res.json()) as {
      nodes?: Array<{ id: string }>;
      links?: Array<{ source: string; target: string }>;
    };
    return { nodes: data.nodes ?? [], links: data.links ?? [] };
  }

  test('a bundle-relative wiki-link from SKILL.md backlinks the reference doc', async () => {
    const refDoc = '.ok/skills/demo/references/notes';
    const skillDoc = '.ok/skills/demo/SKILL';

    await putSkill('demo', '# Demo\n\nSee [[references/notes]] for the deep dive.\n');
    const refRes = await putSkillFile('demo', 'references/notes.md', '# Notes\n\nBody.\n');
    expect(refRes.ok).toBe(true);

    await pollUntil(async () => (await backlinkSources(refDoc)).includes(skillDoc));

    // The phantom top-level `references/notes` must NOT collect the edge.
    expect(await backlinkSources('references/notes')).not.toContain(skillDoc);

    // The per-doc graph panel (`/api/link-graph`, the surface that showed
    // "1 node, 0 links") now contains the SKILL.md → ref edge.
    const graph = await graphNeighborhood(skillDoc);
    expect(graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([skillDoc, refDoc]));
    expect(graph.links).toEqual(expect.arrayContaining([{ source: skillDoc, target: refDoc }]));
  }, 20000);

  test('a bundle-relative markdown link from SKILL.md backlinks the reference doc', async () => {
    const refDoc = '.ok/skills/mdform/references/notes';
    const skillDoc = '.ok/skills/mdform/SKILL';

    await putSkill('mdform', '# Demo\n\nSee [notes](references/notes.md) for context.\n');
    const refRes = await putSkillFile('mdform', 'references/notes.md', '# Notes\n\nBody.\n');
    expect(refRes.ok).toBe(true);

    await pollUntil(async () => (await backlinkSources(refDoc)).includes(skillDoc));
  }, 20000);
});
