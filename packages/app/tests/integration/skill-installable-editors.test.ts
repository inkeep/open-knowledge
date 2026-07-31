import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

/**
 * the install menu must OFFER only editors installable on this machine.
 * Project scope = every editor with a project skill root (install creates the
 * dir). Global scope = only editors whose user-home skill dir EXISTS — a global
 * install never creates a host home, so offering an undetected editor (Copilot
 * with no `~/.copilot`) just no-ops and the checkmark flashes then reverts.
 * The server surfaces `installableEditors` per entry; the menu gates on it.
 *
 */
let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-installable-home-'));
  // Detected global editors: `.claude` present, `.copilot` ABSENT. `.agents` is
  // the vendor-neutral authoring hub for a fresh global skill.
  mkdirSync(join(tmpHome, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

const putSkill = (scope: 'project' | 'global', name: string) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name, frontmatter: { name, description: 'd.' }, body: '# x' }),
  });

describe('installableEditors gating (PRD-7600)', () => {
  test('global offers only detected editors; project offers all', async () => {
    expect((await putSkill('global', 'g-skill')).status).toBe(200);
    expect((await putSkill('project', 'p-skill')).status).toBe(200);

    const res = await fetch(`${base()}/api/skills`);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const global = parsed.data.skills.find((s) => s.name === 'g-skill');
    const project = parsed.data.skills.find((s) => s.name === 'p-skill');
    expect(global?.scope).toBe('global');
    expect(project?.scope).toBe('project');

    // Global: `.claude` detected → offered; `.copilot` absent → NOT offered.
    expect(global?.installableEditors).toContain('claude');
    expect(global?.installableEditors).not.toContain('copilot');

    // Project: install creates the dir, so every project-rooted editor is
    // offered — including Copilot (`.github/skills`).
    expect(project?.installableEditors).toContain('claude');
    expect(project?.installableEditors).toContain('copilot');
  });
});
