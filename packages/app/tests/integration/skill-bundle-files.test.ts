import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestServer, pollUntil, type TestServer } from './test-harness.ts';

/**
 * End-to-end proof through the real server that the skill BUNDLE-FILE surface
 * (`/api/skill-file`) routes correctly by scope × type:
 *  - a PROJECT `.md` reference is a real CRDT content doc — it persists to
 *    `.ok/skills/<name>/references/<x>.md` AND participates in the link graph
 *    (a wiki-link FROM the reference resolves to a backlink on its target),
 *    which is the load-bearing requirement (reuse of the content path).
 *  - a SCRIPT and any bundle file round-trip through the universal per-file
 *    read (`GET /api/skill-file`) without any native `cat`.
 */
describe('skill bundle files via /api/skill-file', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  async function putSkill(name: string, description: string, body: string): Promise<void> {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: 'project', body, frontmatter: { name, description } }),
    });
    if (!res.ok) throw new Error(`skill PUT failed: ${res.status} ${await res.text()}`);
  }

  async function putSkillFile(name: string, path: string, content: string) {
    const res = await fetch(`${base()}/api/skill-file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: 'project', path, content }),
    });
    return res;
  }

  test('a project .md reference persists as a content doc and joins the link graph', async () => {
    await putSkill('demo', 'a demo skill', '# Demo\n\nSee references.\n');

    // A reference whose body links OUT to a target doc — proves the ref is a
    // graph-participating content doc (its forward link resolves).
    const refRes = await putSkillFile(
      'demo',
      'references/notes.md',
      '# Notes\n\nSee [[target-doc]] for context.\n',
    );
    expect(refRes.ok).toBe(true);
    const refBody = (await refRes.json()) as { kind: string; content: boolean; path: string };
    expect(refBody.kind).toBe('reference');
    // `content: true` flags that the write was routed through the CRDT content
    // doc (project `.md` reference), not the fs-direct path.
    expect(refBody.content).toBe(true);

    // It persists to disk at the expected skill-relative path.
    const refFile = resolve(server.contentDir, '.ok', 'skills', 'demo', 'references', 'notes.md');
    await pollUntil(() => existsSync(refFile));
    expect(readFileSync(refFile, 'utf-8')).toContain('[[target-doc]]');

    // Create the link target, then assert the reference shows up as a backlink
    // source — the project `.md` reference is a first-class graph citizen.
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
        data.backlinks.some((b) => b.source === '.ok/skills/demo/references/notes')
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

  /**
   * A skill RENAME git-mv's the dir and rewrites only SKILL.md fs-direct, so the
   * relocated `.md` references never re-enter the link graph at their new doc
   * names — they fall out of the backlink index until a manual rescan. This
   * exercises the LIVE move→index path (no `/api/test-rescan-*`): after the
   * rename the moved reference must STILL resolve as a backlink on its target,
   * at its NEW ref doc name, and the stale old-name source must be gone.
   *
   */
  test('a renamed skill re-indexes its moved .md references into the link graph (no rescan)', async () => {
    await putSkill('demo3', 'a demo skill', '# Demo\n\nSee references.\n');
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

    // Pre-move sanity: the reference resolves at its original doc name.
    await pollUntil(async () =>
      (await backlinkSources('move-target')).includes('.ok/skills/demo3/references/notes'),
    );

    // RENAME the skill — refs are git-mv'd on disk; nothing rewrites them
    // through the CRDT path, so they must be re-indexed by the move handler.
    const moved = await renameSkill('demo3', 'demo3-renamed');
    expect(moved.ok).toBe(true);

    // The moved reference resolves at its NEW ref doc name…
    await pollUntil(async () =>
      (await backlinkSources('move-target')).includes('.ok/skills/demo3-renamed/references/notes'),
    );
    // …and the stale old-name source is gone (not a duplicate).
    const sources = await backlinkSources('move-target');
    expect(sources).not.toContain('.ok/skills/demo3/references/notes');
  }, 20000);

  test('a script round-trips through the universal per-file read (no native cat)', async () => {
    await putSkill('runner', 'runs things', '# Runner\n');
    const scriptText = '#!/usr/bin/env bash\nset -euo pipefail\necho "hello from a skill script"\n';
    const put = await putSkillFile('runner', 'scripts/run.sh', scriptText);
    expect(put.ok).toBe(true);
    const putBody = (await put.json()) as { kind: string; content: boolean };
    expect(putBody.kind).toBe('script');
    // Scripts are fs-direct (never CRDT) — content routing flag is false.
    expect(putBody.content).toBe(false);

    // Read it back via the universal per-file read.
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

  /**
   * A skill REFERENCE graph node is extension-less, so the client reconstructs
   * the read path with a hardcoded `.md`. When the on-disk file is `.mdx`, the
   * GET must fall back to the sibling supported doc extension instead of 404ing
   * (otherwise a `.mdx` reference is unopenable from the graph / links panel).
   *
   */
  test('a .mdx reference opens when requested as .md (extension-less node fallback)', async () => {
    await putSkill('mdxskill', 'has an mdx ref', '# Mdx\n');
    const put = await putSkillFile('mdxskill', 'references/guide.mdx', '# Guide\n\nMDX body.\n');
    expect(put.ok).toBe(true);

    const onDisk = resolve(
      server.contentDir,
      '.ok',
      'skills',
      'mdxskill',
      'references',
      'guide.mdx',
    );
    await pollUntil(() => existsSync(onDisk));

    // Requested as `.md`, but the file is `.mdx` — the server resolves it.
    const params = new URLSearchParams({
      name: 'mdxskill',
      scope: 'project',
      path: 'references/guide.md',
    });
    const get = await fetch(`${base()}/api/skill-file?${params.toString()}`);
    expect(get.ok).toBe(true);
    const got = (await get.json()) as { path: string; kind: string; text: string };
    expect(got.text).toContain('MDX body.');
    // The response reports the REAL resolved path (`.mdx`), not the requested `.md`.
    expect(got.path).toBe('references/guide.mdx');
    expect(got.kind).toBe('reference');
  });

  test('rejects an escaping path and a file write into a non-existent skill', async () => {
    await putSkill('demo2', 'd', '# D\n');
    const escaping = await putSkillFile('demo2', 'references/../../escape.md', 'x');
    expect(escaping.status).toBe(400);

    const ghost = await putSkillFile('ghost-skill', 'references/x.md', 'x');
    expect(ghost.status).toBe(404);
  });
});
