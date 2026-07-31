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
      // skills.sh origin, manual-update only (never auto-pulled).
      expect(entry?.origin?.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
      expect(entry?.origin?.skill).toBe(name);
      expect(entry?.origin?.autoUpdate).toBe(false);
    }
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
