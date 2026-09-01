import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestServer, type TestServer } from './test-harness.ts';

describe('skill SKILL.md → references/<x> inbound backlink (live index)', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });
  const base = () => `http://127.0.0.1:${server.port}`;

  async function putSkill(name: string, body: string): Promise<string> {
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
    const payload = (await res.json()) as { path: string };
    return payload.path.replace(/\/SKILL\.md$/, '');
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

  async function expectBacklink(refDoc: string, skillDoc: string): Promise<void> {
    if (!(await backlinkSources(refDoc)).includes(skillDoc)) {
      const graph = await graphNeighborhood(skillDoc);
      const dead = await (await fetch(`${base()}/api/dead-links`)).json();
      const readDoc = async (name: string) => {
        const r = await fetch(`${base()}/api/document?docName=${encodeURIComponent(name)}`);
        return `${r.status} ${JSON.stringify(await r.text()).slice(0, 240)}`;
      };
      throw new Error(
        `backlink ${skillDoc} -> ${refDoc} never landed.\n` +
          `  backlinks on refDoc: ${JSON.stringify(await backlinkSources(refDoc))}\n` +
          `  skillDoc graph nodes: ${JSON.stringify(graph.nodes.map((n) => n.id))}\n` +
          `  skillDoc graph links: ${JSON.stringify(graph.links)}\n` +
          `  dead links: ${JSON.stringify(dead).slice(0, 400)}\n` +
          `  GET skillDoc: ${await readDoc(skillDoc)}\n` +
          `  GET refDoc: ${await readDoc(refDoc)}\n` +
          `  backlinks on phantom 'references/notes': ` +
          `${JSON.stringify(await backlinkSources('references/notes'))}`,
      );
    }
  }

  test('a bundle-relative wiki-link from SKILL.md backlinks the reference doc', async () => {
    const dir = await putSkill('demo', '# Demo\n\nSee [[references/notes]] for the deep dive.\n');
    const refDoc = `${dir}/references/notes`;
    const skillDoc = `${dir}/SKILL`;

    const refRes = await putSkillFile('demo', 'references/notes.md', '# Notes\n\nBody.\n');
    expect(refRes.ok).toBe(true);

    await expectBacklink(refDoc, skillDoc);

    expect(await backlinkSources('references/notes')).not.toContain(skillDoc);

    const graph = await graphNeighborhood(skillDoc);
    expect(graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([skillDoc, refDoc]));
    expect(graph.links).toEqual(expect.arrayContaining([{ source: skillDoc, target: refDoc }]));
  }, 20000);

  test('a bundle-relative markdown link from SKILL.md backlinks the reference doc', async () => {
    const dir = await putSkill(
      'mdform',
      '# Demo\n\nSee [notes](references/notes.md) for context.\n',
    );
    const refDoc = `${dir}/references/notes`;
    const skillDoc = `${dir}/SKILL`;

    const refRes = await putSkillFile('mdform', 'references/notes.md', '# Notes\n\nBody.\n');
    expect(refRes.ok).toBe(true);

    await expectBacklink(refDoc, skillDoc);
  }, 20000);
});
