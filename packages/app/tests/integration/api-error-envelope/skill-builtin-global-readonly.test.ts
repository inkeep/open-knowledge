/**
 * Integration coverage for OK's user-global built-in skills
 * (`open-knowledge-discovery`, `open-knowledge-write-skill`) being surfaced
 * READ-ONLY through the skills API.
 *
 * Like the project built-in, these are force-installed into the editor host
 * dirs (`<home>/.claude/skills/<name>/`), NOT `<home>/.ok/skills`, and the
 * detected-skills scan filters OK's reserved `open-knowledge*` names — so
 * without explicit surfacing they are invisible in the Skills UI. These tests
 * fake the on-disk global projection under an isolated home and assert:
 *   - `GET /api/skills` lists each as a `managed`, `scope: 'global'` entry.
 *   - `GET /api/skill?scope=global` serves its SKILL.md read-only.
 *
 * Home is overridden to a tempdir so the assertions don't depend on whatever
 * the developer has installed in their real `~/.claude/skills`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENKNOWLEDGE_SKILLS_REPO,
  SkillGetSuccessSchema,
  SkillsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
let homeDir: string;
const base = () => `http://127.0.0.1:${server.port}`;

const GLOBAL_BUILTINS = [
  {
    name: 'open-knowledge-discovery',
    description: 'What OpenKnowledge is and how to install it.',
  },
  {
    name: 'open-knowledge-write-skill',
    description: 'Author a new Agent Skill.',
  },
] as const;

beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'ok-global-builtin-'));
  // Fake the on-disk editor projection the user-global reclaim installs.
  for (const { name, description } of GLOBAL_BUILTINS) {
    const dir = join(homeDir, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBuilt-in.\n`,
      'utf-8',
    );
  }
  server = await createTestServer({ configHomedirOverride: homeDir });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('built-in global open-knowledge skills: read-only surfacing', () => {
  test('GET /api/skills lists each as a managed global entry', async () => {
    const res = await fetch(`${base()}/api/skills`);
    expect(res.status).toBe(200);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const { name, description } of GLOBAL_BUILTINS) {
      const entry = parsed.data.skills.find((s) => s.name === name);
      expect(entry).toBeDefined();
      expect(entry?.managed).toBe(true);
      expect(entry?.scope).toBe('global');
      expect(entry?.installed).toBe(true);
      expect(entry?.hosts).toContain('claude');
      expect(entry?.description).toBe(description);
      // Costed like any other bundle. Omitting it made these the one rows where
      // a skill's context price was invisible, which is what pushed the settings
      // blocks onto the desktop bridge for a number this endpoint has every
      // input for.
      expect(entry?.size?.alwaysOn).toBeGreaterThan(0);
      // skills.sh origin, manual-update only (never auto-pulled).
      expect(entry?.origin?.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
      expect(entry?.origin?.skill).toBe(name);
      expect(entry?.origin?.autoUpdate).toBe(false);
    }
  });

  test('a built-in with NO projection anywhere is still listed, uninstalled', async () => {
    // The lifecycle verbs are ordinary for these skills, so their row has to
    // survive being uninstalled — exactly like any other skill's. It used to
    // vanish from this list once the last host copy went, which took with it the
    // only row the user could install it back from. Sourced from the bundle OK
    // ships, so the row exists before anything is on disk.
    const res = await fetch(`${base()}/api/skills`);
    expect(res.status).toBe(200);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // This home fakes projections for the two GLOBAL built-ins only, so the
    // PROJECT one has no copy anywhere in the fixture.
    const entry = parsed.data.skills.find((s) => s.name === 'open-knowledge');
    expect(entry).toBeDefined();
    expect(entry?.managed).toBe(true);
    expect(entry?.installed).toBe(false);
    expect(entry?.hosts).toEqual([]);
    // Described AND costed from the shipped bundle, so the row can say what it
    // is and what it costs before there is anything on disk to read.
    expect(entry?.description ?? '').not.toBe('');
    expect(entry?.size?.alwaysOn).toBeGreaterThan(0);
    // No installed copy -> no origin: origin describes where the on-disk copy
    // came from, and there is no on-disk copy to describe.
    expect(entry?.origin).toBeUndefined();
  });

  test('installing a built-in that exists nowhere materializes it from the bundle', async () => {
    // The install endpoint otherwise only fans an EXISTING canonical out to more
    // hosts, so a built-in the user had removed everywhere could not be put back
    // through it — 404, with the only code that could create one sitting behind
    // the desktop bridge in settings. That is the split that made settings a
    // second writer of the same state.
    const before = await fetch(`${base()}/api/skills`);
    const beforeParsed = SkillsListSuccessSchema.safeParse(await before.json());
    expect(beforeParsed.success).toBe(true);
    if (!beforeParsed.success) return;
    expect(beforeParsed.data.skills.find((s) => s.name === 'open-knowledge')?.installed).toBe(
      false,
    );

    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', name: 'open-knowledge', targets: ['claude'] }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { hosts?: string[] };
    expect(payload.hosts).toContain('claude');

    const after = await fetch(`${base()}/api/skills`);
    const afterParsed = SkillsListSuccessSchema.safeParse(await after.json());
    expect(afterParsed.success).toBe(true);
    if (!afterParsed.success) return;
    const entry = afterParsed.data.skills.find((s) => s.name === 'open-knowledge');
    expect(entry?.installed).toBe(true);
    expect(entry?.hosts).toContain('claude');
  });

  test('a user-global built-in cannot be materialized into a project', async () => {
    // Each bundle declares where it belongs: discovery is user-global. Letting a
    // project install make its own copy produces a SECOND one beside the global
    // original — the agent loads it twice and the sidebar lists it twice, under
    // PROJECT and GLOBAL. Before the bundle fallback existed this was impossible
    // by accident (nothing on disk to fan out); it has to be impossible on purpose.
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name: 'open-knowledge-discovery',
        targets: ['claude'],
      }),
    });
    expect(res.status).toBe(404);
  });

  test('a built-in cannot be moved between scopes', async () => {
    // Each built-in lives at exactly one tier. A move would not relocate it, it
    // would manufacture a second copy of something already present at the other
    // tier — loaded twice by the agent, listed twice in the sidebar.
    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'open-knowledge-discovery',
        fromScope: 'global',
        toScope: 'project',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toBe('BUILTIN_SCOPE_FIXED');
  });

  test('an ordinary skill that exists nowhere is still a 404', async () => {
    // The bundle fallback is keyed on OK's reserved names and nothing else: for
    // any other skill an absent dir is a caller error and still says so.
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', name: 'not-a-real-skill', targets: ['claude'] }),
    });
    expect(res.status).toBe(404);
  });

  test('GET /api/skill?scope=global serves the body read-only', async () => {
    const res = await fetch(`${base()}/api/skill?name=open-knowledge-discovery&scope=global`);
    expect(res.status).toBe(200);
    const parsed = SkillGetSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.skill.managed).toBe(true);
    expect(parsed.data.skill.body).toContain('Built-in.');
  });
});
