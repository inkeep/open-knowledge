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

  /** Creates the skill and returns its REAL bundle dir rel (creates land at
   *  the default skill home — store retirement). */
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

  /**
   * A freshly created project skill must be DURABLE on disk the instant the
   * create response resolves — not ~100ms later on the natural debounce — so a
   * fast create->rename/delete can't 404 on `existsSync(skillDir)`. Regression
   * for the create-path force-flush (`flushDiskAndDetectOutcome({ force })`).
   */
  test('a newly created skill SKILL.md is on disk before the create response resolves', async () => {
    const dir = await putSkill('fresh', 'durable on create', '# Fresh\n');
    // No pollUntil / debounce wait: the file must already be on disk.
    const skillMd = resolve(server.contentDir, dir, 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);
  });

  test('a project .md reference persists as a content doc and joins the link graph', async () => {
    const demoDir = await putSkill('demo', 'a demo skill', '# Demo\n\nSee references.\n');

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

    // It persists to disk at the expected skill-relative path (the skill's
    // REAL dir — creates land at the default skill home).
    const refFile = resolve(server.contentDir, demoDir, 'references', 'notes.md');
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

    // Pre-move sanity: the reference resolves at its original doc name.
    await pollUntil(async () =>
      (await backlinkSources('move-target')).includes(`${demo3Dir}/references/notes`),
    );

    // RENAME the skill — refs are git-mv'd on disk; nothing rewrites them
    // through the CRDT path, so they must be re-indexed by the move handler.
    const moved = await renameSkill('demo3', 'demo3-renamed');
    expect(moved.ok).toBe(true);

    // The moved reference resolves at its NEW ref doc name…
    // Stuck (not slow) on CI while passing locally — surface the actual index
    // contents so the next failure is a diagnosis rather than a bare timeout.
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
    // …and the stale old-name source is gone (not a duplicate).
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
    const mdxDir = await putSkill('mdxskill', 'has an mdx ref', '# Mdx\n');
    const put = await putSkillFile('mdxskill', 'references/guide.mdx', '# Guide\n\nMDX body.\n');
    expect(put.ok).toBe(true);

    const onDisk = resolve(server.contentDir, mdxDir, 'references', 'guide.mdx');
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

  /**
   * A full-directory skill (import copies the WHOLE dir) can carry files outside
   * references/scripts — a root `config.yaml`, a `data/` subdir. `listSkillFiles`
   * walks the whole dir, so such a file shows in the sidebar tree; the READ must
   * serve it too, or the tree shows a file that fails to open (§8.1: "appears in
   * file mode but says couldn't load in skills mode"). Containment still guards.
   *
   */
  test('a bundle file outside references/scripts (root config.yaml) is readable', async () => {
    const cfgDir = await putSkill('cfgskill', 'has a root config', '# Cfg\n');
    const dir = resolve(server.contentDir, cfgDir);
    await pollUntil(() => existsSync(dir));
    // The restricted PUT only accepts references/scripts, but a full-directory
    // import can land files anywhere — write one directly to mirror that.
    const yaml = 'version: 1\nname: cfgskill\n';
    writeFileSync(resolve(dir, 'config.yaml'), yaml);

    const get = await fetch(
      `${base()}/api/skill-file?name=cfgskill&scope=project&path=config.yaml`,
    );
    expect(get.ok).toBe(true);
    const got = (await get.json()) as { path: string; kind: string; text: string };
    expect(got.text).toBe(yaml);
    expect(got.path).toBe('config.yaml');

    // Containment + basic guards still hold: an empty path and an escaping path
    // are rejected even though the references/scripts restriction is lifted.
    const empty = await fetch(`${base()}/api/skill-file?name=cfgskill&scope=project&path=`);
    expect(empty.status).toBe(400);
    const escaping = await fetch(
      `${base()}/api/skill-file?name=cfgskill&scope=project&path=${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(escaping.status).toBe(400);
  });

  /**
   * DELETE resolves the skill's REAL (in-place) dir — the raw store root
   * silently no-opped every in-place bundle-file delete while reporting
   * success (store-fossil class).
   */
  test('DELETE removes an in-place bundle file from the REAL dir (not a store no-op)', async () => {
    const dirRel = await putSkill('del-target', 'delete pin', '# Body\n');
    expect(dirRel.startsWith('.ok/skills/')).toBe(false); // creates land in-place
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

  /**
   * A DELETE for a path that is not on disk must not tear anything down. Bundle
   * doc names are ext-less, so `references/x.md` and `references/x.mdx` name the
   * SAME live doc: deleting the absent one used to close connections, mark the
   * doc `deleted-upstream` and unload it, killing the surviving sibling's live
   * doc while the unlink itself no-opped.
   */
  test('DELETE of an absent path leaves a same-stem sibling doc intact', async () => {
    const dirRel = await putSkill('stem-clash', 'stem pin', '# Body\n');
    expect((await putSkillFile('stem-clash', 'references/notes.mdx', '# Notes\n')).status).toBe(
      200,
    );
    const survivor = resolve(server.contentDir, dirRel, 'references', 'notes.mdx');
    expect(existsSync(survivor)).toBe(true);

    // Open the survivor so there IS a live doc to tear down — the bug is
    // invisible against an unloaded doc. Its name is ext-less, so the absent
    // `.md` sibling below addresses this exact doc.
    const docName = `${dirRel}/references/notes`;
    const client = await createTestClient(server.port, docName);
    await pollUntil(() => getServerState(server, docName) !== null);

    const del = await fetch(
      `${base()}/api/skill-file?name=stem-clash&scope=project&path=${encodeURIComponent('references/notes.md')}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    expect(((await del.json()) as { existed: boolean }).existed).toBe(false);

    // The no-op delete must not have unloaded the doc, marked it
    // deleted-upstream, or dropped the client's connection.
    const state = getServerState(server, docName);
    expect(state).not.toBeNull();
    expect(state?.connectionCount).toBeGreaterThan(0);
    expect(
      server.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle').get('status'),
    ).toBeUndefined();
    expect(existsSync(survivor)).toBe(true);

    await client.cleanup();
  });

  /**
   * §8.9: rename moves the file on disk, moves the live content-doc identity,
   * and refuses to overwrite an existing destination.
   */
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

    // Occupied destination refuses — never an overwrite.
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

  /**
   * The mutation surface admits ANY in-bundle path (root files, custom dirs) —
   * only SKILL.md stays managed-verbs-only.
   */
  test('PUT writes root files + custom dirs; SKILL.md stays protected', async () => {
    const dirRel = await putSkill('any-path', 'wide surface', '# Body\n');
    expect((await putSkillFile('any-path', 'NOTES.md', '# Root note\n')).status).toBe(200);
    expect((await putSkillFile('any-path', 'assets/tokens/colors.json', '{}\n')).status).toBe(200);
    expect(existsSync(resolve(server.contentDir, dirRel, 'NOTES.md'))).toBe(true);
    expect(existsSync(resolve(server.contentDir, dirRel, 'assets', 'tokens', 'colors.json'))).toBe(
      true,
    );
    // The skill's identity file never mutates through the file surface.
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
