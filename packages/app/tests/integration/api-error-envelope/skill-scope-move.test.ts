/**
 * Regression test (cross-scope move / global-skill re-create). These
 * assertions pin the FIXED behavior; they were RED before the fix.
 *
 * Was the bug: after a global skill is DELETEd, a
 * subsequent `PUT /api/skill scope=global` of the SAME name returned 200 but
 * never wrote `<home>/.ok/skills/<name>/SKILL.md` to disk. The delete unloads
 * the live doc (`captureAndCloseDocuments`) to stop the OLD doc resurrecting the
 * file, but the re-create then short-circuited as a no-op because the parallel
 * managed-artifact LKG cache was never evicted on delete — an identical-content
 * re-create equalled the stale LKG and never re-landed.
 *
 * The fix evicts the managed-artifact LKG on the doc-teardown spine
 * (`evictManagedArtifactLkg` in `captureAndCloseDocuments`), so a same-name
 * re-create persists. NO project skill is required to reproduce — see the
 * "re-create after delete" case below.
 *
 * The user-visible symptom was the sidebar "skill disappears after a scope move
 * until another action": the cross-scope move's compose (PUT dest, DELETE
 * source) makes the move-BACK a re-create-after-delete, so the moved skill was
 * silently lost server-side. (Two earlier CLIENT-side fixes — EditorHeader
 * handoff, sidebar accordion auto-open — were the wrong layer.)
 *
 * Hermetic global home via `configHomedirOverride`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, pollUntil, type TestServer } from '../test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;
const NAME = 'trip-log';

const putSkill = (scope: 'global' | 'project', name = NAME) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      name,
      body: '## When\n\nLogging a trip.',
      frontmatter: { name, description: 'Use when logging a trip.' },
    }),
  });

const delSkill = (scope: 'global' | 'project', name = NAME) =>
  fetch(`${base()}/api/skill?name=${name}&scope=${scope}`, { method: 'DELETE' });

/** Replicate the client `moveSkillScope` server compose: PUT dest, DELETE source. */
async function move(from: 'global' | 'project', to: 'global' | 'project') {
  expect((await putSkill(to)).status).toBe(200);
  expect((await delSkill(from)).status).toBe(200);
}

const putSkillFile = (scope: 'global' | 'project', name: string, path: string, content: string) =>
  fetch(`${base()}/api/skill-file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name, path, content }),
  });

/** List a skill's bundle files (paths) via GET /api/skill (mirrors fetchSkill). */
async function bundleFilePaths(scope: 'global' | 'project', name: string): Promise<string[]> {
  const res = await fetch(`${base()}/api/skill?name=${name}&scope=${scope}`);
  const detail = (await res.json().catch(() => null)) as {
    skill?: { files?: Array<{ path?: string }> };
  } | null;
  return (detail?.skill?.files ?? [])
    .map((f) => f.path)
    .filter((p): p is string => typeof p === 'string');
}

/**
 * Replicate the FIXED cross-scope compose (both `moveSkillCrossScope` MCP +
 * client `moveSkillScope`): PUT dest SKILL.md → copy EVERY bundle file
 * (GET-source + PUT-dest) → only THEN DELETE source. Copy-all-before-delete is
 * the data-safety ordering both composers use.
 */
async function moveFullBundle(from: 'global' | 'project', to: 'global' | 'project', name: string) {
  expect((await putSkill(to, name)).status).toBe(200);
  for (const path of await bundleFilePaths(from, name)) {
    const read = await fetch(`${base()}/api/skill-file?name=${name}&scope=${from}&path=${path}`);
    expect(read.ok).toBe(true);
    const { text } = (await read.json()) as { text: string };
    expect((await putSkillFile(to, name, path, text)).status).toBe(200);
  }
  expect((await delSkill(from, name)).status).toBe(200);
}

async function backlinkSources(target: string): Promise<string[]> {
  const res = await fetch(`${base()}/api/backlinks?docName=${encodeURIComponent(target)}`);
  const data = (await res.json()) as { backlinks?: Array<{ source: string }> };
  return Array.isArray(data.backlinks) ? data.backlinks.map((b) => b.source) : [];
}

async function scopeOf(name: string): Promise<string | undefined> {
  const res = await fetch(`${base()}/api/skills`);
  const parsed = SkillsListSuccessSchema.safeParse(await res.json());
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data.skills.find((s) => s.name === name)?.scope : undefined;
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-scope-move-home-'));
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('E1: cross-scope move / global re-create', () => {
  test('re-create a global skill after deleting it (no project involved)', async () => {
    const N = 'recreate-probe';
    expect((await putSkill('global', N)).status).toBe(200);
    expect(existsSync(join(tmpHome, '.ok', 'skills', N, 'SKILL.md'))).toBe(true);
    expect((await delSkill('global', N)).status).toBe(200);
    expect(existsSync(join(tmpHome, '.ok', 'skills', N, 'SKILL.md'))).toBe(false);
    // Re-create after delete — this PUT returns 200 but currently does NOT persist.
    expect((await putSkill('global', N)).status).toBe(200);
    expect(existsSync(join(tmpHome, '.ok', 'skills', N, 'SKILL.md'))).toBe(true);
  });

  test('global → project → global: list shows it under global at each step', async () => {
    expect((await putSkill('global')).status).toBe(200);
    expect(await scopeOf(NAME)).toBe('global');
    await move('global', 'project');
    expect(await scopeOf(NAME)).toBe('project');
    await move('project', 'global');
    expect(await scopeOf(NAME)).toBe('global');
  });

  /**
   * The cross-scope move's `PUT /api/skill` only writes SKILL.md, so before the
   * fix the source's `references/**` + `scripts/**` were lost when the source
   * dir was deleted. The fixed compose copies the FULL bundle to the destination
   * before deleting the source. Proves the user's scenario: a global skill with
   * a `.md` reference (linking out) AND a script, moved to project, keeps both
   * files AND its `.md` reference rejoins the link graph at the project path —
   * with no test-rescan route.
   *
   */
  test('a cross-scope move carries references + scripts; the project .md ref rejoins the graph', async () => {
    const N = 'bundle-move-probe';
    expect((await putSkill('global', N)).status).toBe(200);
    expect(
      (await putSkillFile('global', N, 'references/notes.md', '# Notes\n\nSee [[xs-target]].\n'))
        .status,
    ).toBe(200);
    const script = '#!/usr/bin/env bash\necho hi\n';
    expect((await putSkillFile('global', N, 'scripts/run.sh', script)).status).toBe(200);

    await moveFullBundle('global', 'project', N);

    // (a) both bundle files now live at the PROJECT skill path on disk…
    const projRef = join(server.contentDir, '.ok', 'skills', N, 'references', 'notes.md');
    const projScript = join(server.contentDir, '.ok', 'skills', N, 'scripts', 'run.sh');
    expect(existsSync(projRef)).toBe(true);
    expect(existsSync(projScript)).toBe(true);
    expect(readFileSync(projScript, 'utf-8')).toBe(script);
    // (b) the source GLOBAL dir is gone.
    expect(existsSync(join(tmpHome, '.ok', 'skills', N))).toBe(false);
    expect(await scopeOf(N)).toBe('project');

    // (c) the project `.md` reference participates in the backlink graph at its
    //     new content-doc name (live path — no rescan).
    const target = await fetch(`${base()}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'xs-target', markdown: '# T\n', position: 'replace' }),
    });
    expect(target.ok).toBe(true);
    await pollUntil(async () =>
      (await backlinkSources('xs-target')).includes(`.ok/skills/${N}/references/notes`),
    );
  }, 20000);
});
