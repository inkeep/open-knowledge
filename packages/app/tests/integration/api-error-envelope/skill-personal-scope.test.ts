/**
 * Global-scope skills: authored at `<home>/.ok/skills/`, listed
 * alongside project skills, edited, installed into the user-global host dirs
 * (`<home>/.{host}/skills/`), and deleted — but UNVERSIONED (no shadow repo for
 * the user home), so history is always empty and restore is refused.
 *
 * Hermetic via the `configHomedirOverride` seam (the single user-home override
 * that also resolves `~/.ok/global.yml`), so global writes land in a
 * throwaway tempdir, never the real user home. (Bun's `os.homedir()` ignores
 * `$HOME`, so an env override wouldn't work — the seam is threaded explicitly.)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProblemDetailsSchema,
  SkillGetSuccessSchema,
  SkillsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const putSkill = (body: Record<string, unknown>) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-personal-home-'));
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('global-scope skills', () => {
  test('PUT global → writes under <home>/.ok/skills/', async () => {
    const res = await putSkill({
      scope: 'global',
      name: 'daily-standup',
      body: '## When\n\nEvery morning.',
      frontmatter: { name: 'daily-standup', description: 'Use when writing a standup update.' },
    });
    expect(res.status).toBe(200);
    // The source landed in the overridden home, not the project content dir.
    expect(existsSync(join(tmpHome, '.ok', 'skills', 'daily-standup', 'SKILL.md'))).toBe(true);
  });

  test('GET global returns the payload', async () => {
    const res = await fetch(`${base()}/api/skill?name=daily-standup&scope=global`);
    expect(res.status).toBe(200);
    const parsed = SkillGetSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skill.scope).toBe('global');
      expect(parsed.data.skill.frontmatter.description).toBe('Use when writing a standup update.');
    }
  });

  test('GET /api/skills lists the global skill with scope=global', async () => {
    // Seed a project skill too, to prove the union surfaces both scopes.
    await putSkill({
      scope: 'project',
      name: 'project-only',
      frontmatter: { name: 'project-only', description: 'A project skill.' },
    });
    const res = await fetch(`${base()}/api/skills`);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const personal = parsed.data.skills.find((s) => s.name === 'daily-standup');
      const project = parsed.data.skills.find((s) => s.name === 'project-only');
      expect(personal?.scope).toBe('global');
      expect(project?.scope).toBe('project');
      // Global install isn't wired yet → not installed, no hosts.
      expect(personal?.installed).toBe(false);
      expect(personal?.hosts).toEqual([]);
    }
  });

  test('global history is always empty (unversioned)', async () => {
    const res = await fetch(
      `${base()}/api/history?docName=${encodeURIComponent('__skill__/global/daily-standup')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  test('restore on a global skill → 400 (unversioned)', async () => {
    const res = await fetch(`${base()}/api/skill/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', name: 'daily-standup', version: 'deadbeef' }),
    });
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.safeParse(await res.json()).success).toBe(true);
  });

  test('install a global skill → projects into the user-global host dirs', async () => {
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', name: 'daily-standup', targets: ['claude'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: string[] };
    expect(body.hosts).toContain('claude');
    // Projected verbatim into the overridden home's global host dir, and the
    // user-level install marker recorded it.
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'daily-standup', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.ok', 'local', 'installed-skills.json'))).toBe(true);
  });

  test('list reflects the global skill as installed after install', async () => {
    const res = await fetch(`${base()}/api/skills`);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const personal = parsed.data.skills.find((s) => s.name === 'daily-standup');
      expect(personal?.installed).toBe(true);
      expect(personal?.hosts).toContain('claude');
    }
  });

  test('uninstall demotes the global skill to Draft (source kept, projection gone)', async () => {
    const res = await fetch(`${base()}/api/skill/uninstall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', name: 'daily-standup' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uninstalled: boolean };
    expect(body.uninstalled).toBe(true);
    // Source kept; global projection removed.
    expect(existsSync(join(tmpHome, '.ok', 'skills', 'daily-standup', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'daily-standup'))).toBe(false);
    // List now shows it as a Draft again.
    const list = await fetch(`${base()}/api/skills`);
    const parsed = SkillsListSuccessSchema.safeParse(await list.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const personal = parsed.data.skills.find((s) => s.name === 'daily-standup');
      expect(personal?.installed).toBe(false);
      expect(personal?.hosts).toEqual([]);
    }
  });

  test('DELETE global removes the source + its global projection', async () => {
    const res = await fetch(`${base()}/api/skill?name=daily-standup&scope=global`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(tmpHome, '.ok', 'skills', 'daily-standup'))).toBe(false);
    // Reverse-projection cleaned the global host dir too.
    expect(existsSync(join(tmpHome, '.claude', 'skills', 'daily-standup'))).toBe(false);
  });
});
