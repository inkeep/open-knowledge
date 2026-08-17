import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_SKILL_EDITOR_IDS,
  SkillInstallSuccessSchema,
  SkillsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

/**
 * the install menu must OFFER only editors installable on this machine, and
 * BOTH scopes now gate on the same rule: the editor's home already exists.
 * Global reads `~/.<host>`, project `<projectDir>/.<host>`. Offering an
 * undetected editor either no-ops and reverts the checkmark, or succeeds by
 * creating a dotdir for a tool the user does not have — which OK's own
 * directory-based detection then reports back as installed.
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
  // `.gemini` is a DETECTED user skill host (Antigravity's user root is
  // `~/.gemini/skills`) that has no project skill root, so it is not an
  // install target. It also belongs to the standalone Gemini CLI, so its
  // presence is not even evidence Antigravity is installed.
  mkdirSync(join(tmpHome, '.gemini'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

// The adoption cases below mkdir into the SHARED contentDir, and the baseline
// assertion above depends on those dirs being absent. Without this the file
// passes only because declaration order happens to match dependency order — a
// shuffle, `test.concurrent`, or a moved case would turn it red for a reason
// that has nothing to do with the behaviour under test.
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

    // Global: `.claude` detected → offered; `.copilot` absent → NOT offered.
    expect(global?.installableEditors).toContain('claude');
    expect(global?.installableEditors).not.toContain('copilot');

    // Project: `.claude/skills` is seeded in the fixture → offered. Copilot's
    // project root (`.github/skills`) is not there → NOT offered. It used to be,
    // on the reasoning that install would create the dir.
    expect(project?.installableEditors).toContain('claude');
    expect(project?.installableEditors).not.toContain('copilot');
  });

  /**
   * The activation path, not the bare dotdir. Copilot's project root is
   * `.github/skills`, and `.github` exists in nearly every git repo for
   * workflows and CODEOWNERS — gating on the dotdir would offer Copilot
   * essentially everywhere.
   *
   */
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

  /**
   * An agent home WITHOUT its `skills/` subdir is still adoption: the project
   * has the tool, it just has no skills installed yet. OK may create `skills/`
   * inside a dotdir that already exists — that is the whole distinction between
   * the activation path and the skills root.
   *
   */
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

  // A row in `folders[]` is a WRITE DESTINATION — the Folders surface links and
  // unlinks it. A standard root under a dotdir that is not there belongs to a
  // tool the user does not have, so listing it is an offer to create that
  // dotdir; OK's directory-based detection then reads what it created back as
  // "installed", and one accepted offer manufactures its own evidence.
  //
  test('a standard root whose dotdir is absent is not offered, and appears once it exists', async () => {
    expect(existsSync(join(server.contentDir, '.codex'))).toBe(false);
    expect(await folderRoots()).not.toContain('.codex/skills');

    // Adopting the host activates the root even with no `skills/` subdir yet:
    // the dotdir is the adoption signal, and OK may create `skills/` under it.
    mkdirSync(join(server.contentDir, '.codex'), { recursive: true });
    expect(await folderRoots()).toContain('.codex/skills');
  });

  // `.github` is shared with tools that have nothing to do with agents, so the
  // dotdir alone proves nothing — `skillRootActivationPath` requires the whole
  // root. This is the case a gate written as "does the dotdir exist" gets wrong.
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

    // The list carries the cost so the editor prices a skill without re-reading
    // it: name+description drive always-on, the body drives on-trigger, and a
    // bundle with no readable references reports zero on-demand (not NaN/absent).
    const entry = parsed.data.skills.find((s) => s.name === name);
    expect(entry?.size?.alwaysOn).toBeGreaterThan(0);
    expect(entry?.size?.onTrigger).toBeGreaterThan(0);
    expect(entry?.size?.onDemand).toBe(0);
  });
});

describe('default global install targets stay in the install-target vocabulary', () => {
  /**
   * Detection (`~/.gemini` → antigravity) is WIDER than the install-target
   * vocabulary: an editor with no project skill root has no checkbox in the
   * picker and is filtered out of `resolvedHosts`, so a projection there could
   * never be seen or removed by a later set-exact install. Omitting `targets`
   * must therefore yield the same vocabulary an explicit list is filtered to.
   *
   */
  test('omitting targets never projects into a detected non-target host', async () => {
    const name = 'vocab-skill';
    expect((await putSkill('global', name)).status).toBe(200);

    // `targets` OMITTED → the defaults branch under test.
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', name }),
    });
    expect(res.status).toBe(200);
    const parsed = SkillInstallSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Detection really ran: `.claude` is detected AND a valid target.
    expect(parsed.data.hosts).toContain('claude');
    // …and every emitted host round-trips (`agents` is the hub, not an editor).
    const vocabulary = new Set<string>([...PROJECT_SKILL_EDITOR_IDS, 'agents']);
    expect(parsed.data.hosts.filter((h) => !vocabulary.has(h))).toEqual([]);
    expect(existsSync(join(tmpHome, '.gemini', 'skills', name))).toBe(false);
  });
});
