import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createTestClient,
  createTestServer,
  getServerState,
  pollUntil,
  type TestServer,
} from './test-harness.ts';

describe('skill bundle files via /api/skill-file', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  async function putSkill(name: string, description: string, body: string): Promise<string> {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: 'project', body, frontmatter: { name, description } }),
    });
    if (!res.ok) throw new Error(`skill PUT failed: ${res.status} ${await res.text()}`);
    const payload = (await res.json()) as { path: string };
    return payload.path.replace(/\/SKILL\.md$/, '');
  }

  async function putSkillFile(name: string, path: string, content: string) {
    const res = await fetch(`${base()}/api/skill-file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: 'project', path, content }),
    });
    return res;
  }

  test('a newly created skill SKILL.md is on disk before the create response resolves', async () => {
    const dir = await putSkill('fresh', 'durable on create', '# Fresh\n');
    const skillMd = resolve(server.contentDir, dir, 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);
  });

  test('a project .md reference persists as a content doc and joins the link graph', async () => {
    const demoDir = await putSkill('demo', 'a demo skill', '# Demo\n\nSee references.\n');

    const refRes = await putSkillFile(
      'demo',
      'references/notes.md',
      '# Notes\n\nSee [[target-doc]] for context.\n',
    );
    expect(refRes.ok).toBe(true);
    const refBody = (await refRes.json()) as { kind: string; content: boolean; path: string };
    expect(refBody.kind).toBe('reference');
    expect(refBody.content).toBe(true);

    const refFile = resolve(server.contentDir, demoDir, 'references', 'notes.md');
    await pollUntil(() => existsSync(refFile));
    expect(readFileSync(refFile, 'utf-8')).toContain('[[target-doc]]');

    const target = await fetch(`${base()}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: 'target-doc',
        markdown: '# Target\n\nBody.\n',
        position: 'replace',
      }),
    });
    expect(target.ok).toBe(true);

    await pollUntil(async () => {
      const res = await fetch(`${base()}/api/backlinks?docName=target-doc`);
      const data = (await res.json()) as { backlinks?: Array<{ source: string }> };
      return (
        Array.isArray(data.backlinks) &&
        data.backlinks.some((b) => b.source === `${demoDir}/references/notes`)
      );
    });
  });

  async function renameSkill(fromName: string, toName: string) {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', fromName, toName }),
    });
    return res;
  }

  async function backlinkSources(target: string): Promise<string[]> {
    const res = await fetch(`${base()}/api/backlinks?docName=${encodeURIComponent(target)}`);
    const data = (await res.json()) as { backlinks?: Array<{ source: string }> };
    return Array.isArray(data.backlinks) ? data.backlinks.map((b) => b.source) : [];
  }

  test('a renamed skill re-indexes its moved .md references into the link graph (no rescan)', async () => {
    const demo3Dir = await putSkill('demo3', 'a demo skill', '# Demo\n\nSee references.\n');
    const demo3Root = demo3Dir.split('/').slice(0, -1).join('/');
    const refRes = await putSkillFile(
      'demo3',
      'references/notes.md',
      '# Notes\n\nSee [[move-target]] for context.\n',
    );
    expect(refRes.ok).toBe(true);

    const target = await fetch(`${base()}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'move-target', markdown: '# Target\n', position: 'replace' }),
    });
    expect(target.ok).toBe(true);

    await pollUntil(async () =>
      (await backlinkSources('move-target')).includes(`${demo3Dir}/references/notes`),
    );

    const moved = await renameSkill('demo3', 'demo3-renamed');
    expect(moved.ok).toBe(true);

    const expectedRef = `${demo3Root}/demo3-renamed/references/notes`;
    let lastSources: string[] = [];
    try {
      await pollUntil(async () => {
        lastSources = await backlinkSources('move-target');
        return lastSources.includes(expectedRef);
      }, 20_000);
    } catch (err) {
      throw new Error(
        `renamed skill's reference never re-indexed.
  skill dir   : ${demo3Dir}
  skill root  : ${demo3Root}
  expected ref: ${expectedRef}
  backlinks   : ${JSON.stringify(lastSources)}
${String(err)}`,
      );
    }
    const sources = await backlinkSources('move-target');
    expect(sources).not.toContain(`${demo3Dir}/references/notes`);
  }, 20000);

  test('a script round-trips through the universal per-file read (no native cat)', async () => {
    await putSkill('runner', 'runs things', '# Runner\n');
    const scriptText = '#!/usr/bin/env bash\nset -euo pipefail\necho "hello from a skill script"\n';
    const put = await putSkillFile('runner', 'scripts/run.sh', scriptText);
    expect(put.ok).toBe(true);
    const putBody = (await put.json()) as { kind: string; content: boolean };
    expect(putBody.kind).toBe('script');
    expect(putBody.content).toBe(false);

    const params = new URLSearchParams({
      name: 'runner',
      scope: 'project',
      path: 'scripts/run.sh',
    });
    const get = await fetch(`${base()}/api/skill-file?${params.toString()}`);
    expect(get.ok).toBe(true);
    const got = (await get.json()) as { path: string; kind: string; text: string };
    expect(got.kind).toBe('script');
    expect(got.text).toBe(scriptText);
  });

  test('a .mdx reference opens when requested as .md (extension-less node fallback)', async () => {
    const mdxDir = await putSkill('mdxskill', 'has an mdx ref', '# Mdx\n');
    const put = await putSkillFile('mdxskill', 'references/guide.mdx', '# Guide\n\nMDX body.\n');
    expect(put.ok).toBe(true);

    const onDisk = resolve(server.contentDir, mdxDir, 'references', 'guide.mdx');
    await pollUntil(() => existsSync(onDisk));

    const params = new URLSearchParams({
      name: 'mdxskill',
      scope: 'project',
      path: 'references/guide.md',
    });
    const get = await fetch(`${base()}/api/skill-file?${params.toString()}`);
    expect(get.ok).toBe(true);
    const got = (await get.json()) as { path: string; kind: string; text: string };
    expect(got.text).toContain('MDX body.');
    expect(got.path).toBe('references/guide.mdx');
    expect(got.kind).toBe('reference');
  });

  test('a bundle file outside references/scripts (root config.yaml) is readable', async () => {
    const cfgDir = await putSkill('cfgskill', 'has a root config', '# Cfg\n');
    const dir = resolve(server.contentDir, cfgDir);
    await pollUntil(() => existsSync(dir));
    const yaml = 'version: 1\nname: cfgskill\n';
    writeFileSync(resolve(dir, 'config.yaml'), yaml);

    const get = await fetch(
      `${base()}/api/skill-file?name=cfgskill&scope=project&path=config.yaml`,
    );
    expect(get.ok).toBe(true);
    const got = (await get.json()) as { path: string; kind: string; text: string };
    expect(got.text).toBe(yaml);
    expect(got.path).toBe('config.yaml');

    const empty = await fetch(`${base()}/api/skill-file?name=cfgskill&scope=project&path=`);
    expect(empty.status).toBe(400);
    const escaping = await fetch(
      `${base()}/api/skill-file?name=cfgskill&scope=project&path=${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(escaping.status).toBe(400);
  });

  test('DELETE removes an in-place bundle file from the REAL dir (not a store no-op)', async () => {
    const dirRel = await putSkill('del-target', 'delete pin', '# Body\n');
    expect(dirRel.startsWith('.ok/skills/')).toBe(false);
    expect((await putSkillFile('del-target', 'references/gone.md', '# Gone\n')).status).toBe(200);
    const abs = resolve(server.contentDir, dirRel, 'references', 'gone.md');
    expect(existsSync(abs)).toBe(true);

    const del = await fetch(
      `${base()}/api/skill-file?name=del-target&scope=project&path=${encodeURIComponent('references/gone.md')}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    const payload = (await del.json()) as { existed: boolean };
    expect(payload.existed).toBe(true);
    expect(existsSync(abs)).toBe(false);
  });

  test('DELETE of an absent path leaves a same-stem sibling doc intact', async () => {
    const dirRel = await putSkill('stem-clash', 'stem pin', '# Body\n');
    expect((await putSkillFile('stem-clash', 'references/notes.mdx', '# Notes\n')).status).toBe(
      200,
    );
    const survivor = resolve(server.contentDir, dirRel, 'references', 'notes.mdx');
    expect(existsSync(survivor)).toBe(true);

    const docName = `${dirRel}/references/notes`;
    const client = await createTestClient(server.port, docName);
    await pollUntil(() => getServerState(server, docName) !== null);

    const del = await fetch(
      `${base()}/api/skill-file?name=stem-clash&scope=project&path=${encodeURIComponent('references/notes.md')}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    expect(((await del.json()) as { existed: boolean }).existed).toBe(false);

    const state = getServerState(server, docName);
    expect(state).not.toBeNull();
    expect(state?.connectionCount).toBeGreaterThan(0);
    expect(
      server.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle').get('status'),
    ).toBeUndefined();
    expect(existsSync(survivor)).toBe(true);

    await client.cleanup();
  });

  test('rename moves an in-place .md reference (disk + doc identity), never overwrites', async () => {
    const dirRel = await putSkill('rename-target', 'rename pin', '# Body\n');
    expect((await putSkillFile('rename-target', 'references/old.md', '# Old\n')).status).toBe(200);
    expect((await putSkillFile('rename-target', 'references/taken.md', '# Taken\n')).status).toBe(
      200,
    );

    const rename = (from: string, to: string) =>
      fetch(`${base()}/api/skill-file/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rename-target', scope: 'project', from, to }),
      });

    expect((await rename('references/old.md', 'references/taken.md')).status).toBe(400);

    const res = await rename('references/old.md', 'references/deep/new.md');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      fromDocName?: string;
      toDocName?: string;
    };
    expect(payload.fromDocName).toBe(`${dirRel}/references/old`);
    expect(payload.toDocName).toBe(`${dirRel}/references/deep/new`);
    expect(existsSync(resolve(server.contentDir, dirRel, 'references', 'old.md'))).toBe(false);
    expect(
      readFileSync(resolve(server.contentDir, dirRel, 'references', 'deep', 'new.md'), 'utf-8'),
    ).toContain('# Old');
  });

  test('PUT writes root files + custom dirs; SKILL.md stays protected', async () => {
    const dirRel = await putSkill('any-path', 'wide surface', '# Body\n');
    expect((await putSkillFile('any-path', 'NOTES.md', '# Root note\n')).status).toBe(200);
    expect((await putSkillFile('any-path', 'assets/tokens/colors.json', '{}\n')).status).toBe(200);
    expect(existsSync(resolve(server.contentDir, dirRel, 'NOTES.md'))).toBe(true);
    expect(existsSync(resolve(server.contentDir, dirRel, 'assets', 'tokens', 'colors.json'))).toBe(
      true,
    );
    expect((await putSkillFile('any-path', 'SKILL.md', '# hijack\n')).status).toBe(400);
  });

  test('rejects an escaping path and a file write into a non-existent skill', async () => {
    await putSkill('demo2', 'd', '# D\n');
    const escaping = await putSkillFile('demo2', 'references/../../escape.md', 'x');
    expect(escaping.status).toBe(400);

    const ghost = await putSkillFile('ghost-skill', 'references/x.md', 'x');
    expect(ghost.status).toBe(404);
  });
});
