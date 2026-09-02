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
      expect(entry?.size?.alwaysOn).toBeGreaterThan(0);
      expect(entry?.origin?.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
      expect(entry?.origin?.skill).toBe(name);
      expect(entry?.origin?.autoUpdate).toBe(false);
    }
  });

  test('a built-in with NO projection anywhere is still listed, uninstalled', async () => {
    const res = await fetch(`${base()}/api/skills`);
    expect(res.status).toBe(200);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const entry = parsed.data.skills.find((s) => s.name === 'open-knowledge');
    expect(entry).toBeDefined();
    expect(entry?.managed).toBe(true);
    expect(entry?.installed).toBe(false);
    expect(entry?.hosts).toEqual([]);
    expect(entry?.description ?? '').not.toBe('');
    expect(entry?.size?.alwaysOn).toBeGreaterThan(0);
    expect(entry?.origin).toBeUndefined();
  });

  test('installing a built-in that exists nowhere materializes it from the bundle', async () => {
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
