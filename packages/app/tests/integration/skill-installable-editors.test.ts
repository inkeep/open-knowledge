import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SkillInstallSuccessSchema,
  SkillsListSuccessSchema,
  USER_SKILL_EDITOR_IDS,
} from '@inkeep/open-knowledge-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-installable-home-'));
  mkdirSync(join(tmpHome, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(tmpHome, '.gemini'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  for (const dir of ['.github', '.codex']) {
    rmSync(join(server.contentDir, dir), { recursive: true, force: true });
  }
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

    expect(global?.installableEditors).toContain('claude');
    expect(global?.installableEditors).not.toContain('copilot');

    expect(project?.installableEditors).toContain('claude');
    expect(project?.installableEditors).not.toContain('copilot');
  });

  test('a bare .github does not adopt Copilot, but .github/skills does', async () => {
    const installable = async (): Promise<string[]> => {
      const parsed = SkillsListSuccessSchema.safeParse(
        await (await fetch(`${base()}/api/skills`)).json(),
      );
      if (!parsed.success) throw new Error('skills list failed schema validation');
      return parsed.data.skills.find((s) => s.name === 'p-skill')?.installableEditors ?? [];
    };

    mkdirSync(join(server.contentDir, '.github'), { recursive: true });
    expect(await installable()).not.toContain('copilot');

    mkdirSync(join(server.contentDir, '.github', 'skills'), { recursive: true });
    expect(await installable()).toContain('copilot');
  });

  test('an agent home with no skills subdir is still an offered target', async () => {
    mkdirSync(join(server.contentDir, '.codex'), { recursive: true });
    expect(existsSync(join(server.contentDir, '.codex', 'skills'))).toBe(false);

    const parsed = SkillsListSuccessSchema.safeParse(
      await (await fetch(`${base()}/api/skills`)).json(),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.skills.find((s) => s.name === 'p-skill')?.installableEditors).toContain(
      'codex',
    );
  });
});

describe('skill-targets folders are gated on activation (PRD-7985)', () => {
  const folderRoots = async (): Promise<string[]> => {
    const res = await fetch(`${base()}/api/skill-targets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders?: { root: string; scope: string }[] };
    return (body.folders ?? []).filter((f) => f.scope === 'project').map((f) => f.root);
  };

  test('a standard root whose dotdir is absent is not offered, and appears once it exists', async () => {
    expect(existsSync(join(server.contentDir, '.codex'))).toBe(false);
    expect(await folderRoots()).not.toContain('.codex/skills');

    mkdirSync(join(server.contentDir, '.codex'), { recursive: true });
    expect(await folderRoots()).toContain('.codex/skills');
  });

  test('a non-agent dotdir does not activate its root; only the full root does', async () => {
    mkdirSync(join(server.contentDir, '.github'), { recursive: true });
    expect(await folderRoots()).not.toContain('.github/skills');

    mkdirSync(join(server.contentDir, '.github', 'skills'), { recursive: true });
    expect(await folderRoots()).toContain('.github/skills');
  });
});

describe('three-tier size on the skills list (PRD-7978)', () => {
  test('an in-place skill entry carries its server-computed three-tier cost', async () => {
    const name = 'sized-skill';
    expect((await putSkill('project', name)).status).toBe(200);

    const res = await fetch(`${base()}/api/skills`);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const entry = parsed.data.skills.find((s) => s.name === name);
    expect(entry?.size?.alwaysOn).toBeGreaterThan(0);
    expect(entry?.size?.onTrigger).toBeGreaterThan(0);
    expect(entry?.size?.onDemand).toBe(0);
  });
});

describe('default global install targets stay in the install-target vocabulary', () => {
  test('omitted targets project into every detected user host, and all of them round-trip', async () => {
    const name = 'vocab-skill';
    expect((await putSkill('global', name)).status).toBe(200);

    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', name }),
    });
    expect(res.status).toBe(200);
    const parsed = SkillInstallSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.hosts).toContain('claude');
    expect(parsed.data.hosts).toContain('antigravity');
    const vocabulary = new Set<string>([...USER_SKILL_EDITOR_IDS, 'agents']);
    expect(parsed.data.hosts.filter((h) => !vocabulary.has(h))).toEqual([]);
    expect(existsSync(join(tmpHome, '.gemini', 'skills', name))).toBe(true);

    const removal = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', name, targets: ['claude'] }),
    });
    expect(removal.status).toBe(200);
    expect(existsSync(join(tmpHome, '.gemini', 'skills', name))).toBe(false);
  });
});
