/**
 * Cross-scope move must not orphan the SOURCE skill's editor-host projections.
 *
 * Dogfooding scenario: a skill is project-installed into claude + cursor +
 * codex, the user moves it project→global (and the reverse), and the OLD source
 * projections (`.claude/skills/<name>`, `.cursor/skills/<name>`,
 * `.codex/skills/<name>`) must all be torn down — not left dangling at the
 * source scope. The cross-scope move composers (`moveSkillCrossScope` MCP +
 * client `moveSkillScope`) DELETE the source after copying the bundle, and the
 * source DELETE runs `uninstallSkillFromHostDirs(skillInstallBase(fromScope))`,
 * which reverse-projects across ALL editors. This pins that contract end-to-end
 * in BOTH directions.
 *
 * Project install base is `projectDir` (= `contentDir` for this server), so
 * project projections live under `<contentDir>/.{host}/skills/`. Global install
 * base is `<home>` (the `configHomedirOverride` seam), so global projections
 * live under `<home>/.{host}/skills/`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;
// Default skill home per base (existence-activated `.agents`, else `.claude`).
const skillsRootIn = (b: string) =>
  existsSync(join(b, '.agents')) ? join(b, '.agents', 'skills') : join(b, '.claude', 'skills');

/** The editors a project install fans out to (claude + cursor + codex). */
const EDITORS = ['claude', 'cursor', 'codex'] as const;
const HOST_DOTDIR: Record<(typeof EDITORS)[number], string> = {
  claude: '.claude',
  cursor: '.cursor',
  codex: '.codex',
};

const putSkill = (scope: 'global' | 'project', name: string) =>
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

const delSkill = (scope: 'global' | 'project', name: string) =>
  fetch(`${base()}/api/skill?name=${name}&scope=${scope}`, { method: 'DELETE' });

const installSkill = (scope: 'global' | 'project', name: string, targets: readonly string[]) =>
  fetch(`${base()}/api/skill/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name, targets }),
  });

/** Source skill dir for a scope — creates land at the default skill home (`.claude/skills` in a fresh tree; store retirement). */
const skillSrc = (scope: 'global' | 'project', name: string) =>
  scope === 'global'
    ? join(skillsRootIn(tmpHome), name)
    : join(skillsRootIn(server.contentDir), name);

/** Editor-host projection dir for a scope×editor (the install base differs). */
const projectionDir = (
  scope: 'global' | 'project',
  editor: (typeof EDITORS)[number],
  name: string,
) =>
  scope === 'global'
    ? join(tmpHome, HOST_DOTDIR[editor], 'skills', name)
    : join(server.contentDir, HOST_DOTDIR[editor], 'skills', name);

/**
 * Replicate the FIXED cross-scope compose (both `moveSkillCrossScope` MCP +
 * client `moveSkillScope`): PUT dest SKILL.md, then DELETE source. (No bundle
 * files here — the bundle-carry path is covered by skill-scope-move.test.ts;
 * this test isolates the projection-teardown.) The destination is NOT installed
 * — a moved skill lands as a Draft to re-install for its new scope, so any
 * surviving SOURCE-scope projection is a true orphan.
 */
async function moveCrossScope(
  from: 'global' | 'project',
  to: 'global' | 'project',
  name: string,
): Promise<string> {
  const put = await putSkill(to, name);
  expect(put.status).toBe(200);
  const payload = (await put.json()) as { path: string };
  expect((await delSkill(from, name)).status).toBe(200);
  // The destination's REAL dir (creates land at the default skill home).
  return payload.path.replace(/\/SKILL\.md$/, '');
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-xscope-uninstall-home-'));
  // Adopt the vendor-neutral `.agents` hub in the throwaway home. A
  // caller-supplied `configHomedirOverride` owns its own host set, and skill
  // destinations resolve via `resolveDefaultSkillHomeRel`, which refuses (400
  // `NO_USABLE_SKILL_HOME`) when the home has adopted none — OK never creates
  // one on the user's behalf. The hub, not `.claude`, keeps the global source
  // dir distinct from the claude PROJECTION dir this file asserts on.
  mkdirSync(join(tmpHome, '.agents', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('DELETE uninstalls a multi-editor install (the move relies on this)', () => {
  test('project skill: install claude+cursor+codex → DELETE → all projections gone', async () => {
    const N = 'del-project-probe';
    expect((await putSkill('project', N)).status).toBe(200);
    expect((await installSkill('project', N, EDITORS)).status).toBe(200);
    for (const e of EDITORS) {
      expect(existsSync(join(projectionDir('project', e, N), 'SKILL.md'))).toBe(true);
    }

    expect((await delSkill('project', N)).status).toBe(200);
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('project', e, N))).toBe(false);
    }
    expect(existsSync(skillSrc('project', N))).toBe(false);
  });

  test('global skill: install claude+cursor+codex → DELETE → all projections gone', async () => {
    const N = 'del-global-probe';
    expect((await putSkill('global', N)).status).toBe(200);
    expect((await installSkill('global', N, EDITORS)).status).toBe(200);
    for (const e of EDITORS) {
      expect(existsSync(join(projectionDir('global', e, N), 'SKILL.md'))).toBe(true);
    }

    expect((await delSkill('global', N)).status).toBe(200);
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('global', e, N))).toBe(false);
    }
    expect(existsSync(skillSrc('global', N))).toBe(false);
  });
});

describe('cross-scope move removes the SOURCE projections in both directions', () => {
  test('project → global: project claude+cursor+codex projections all removed', async () => {
    const N = 'move-p2g-probe';
    expect((await putSkill('project', N)).status).toBe(200);
    expect((await installSkill('project', N, EDITORS)).status).toBe(200);
    for (const e of EDITORS) {
      expect(existsSync(join(projectionDir('project', e, N), 'SKILL.md'))).toBe(true);
    }

    await moveCrossScope('project', 'global', N);

    // Every project-scope source projection is torn down (no orphans).
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('project', e, N))).toBe(false);
    }
    // Source dir gone; destination exists as an un-projected Draft.
    expect(existsSync(skillSrc('project', N))).toBe(false);
    expect(existsSync(join(skillSrc('global', N), 'SKILL.md'))).toBe(true);
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('global', e, N))).toBe(false);
    }
  });

  test('global → project: global claude+cursor+codex projections all removed', async () => {
    const N = 'move-g2p-probe';
    expect((await putSkill('global', N)).status).toBe(200);
    expect((await installSkill('global', N, EDITORS)).status).toBe(200);
    for (const e of EDITORS) {
      expect(existsSync(join(projectionDir('global', e, N), 'SKILL.md'))).toBe(true);
    }

    const destPath = await moveCrossScope('global', 'project', N);

    // Every global-scope source projection is torn down (no orphans).
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('global', e, N))).toBe(false);
    }
    // Source dir gone; destination exists (at the server-reported real path).
    expect(existsSync(skillSrc('global', N))).toBe(false);
    expect(existsSync(join(server.contentDir, destPath, 'SKILL.md'))).toBe(true);
    for (const e of EDITORS) {
      const dir = projectionDir('project', e, N);
      // In-place model: the destination default home may BE an editor's dir —
      // that occurrence is the skill itself, not a stale projection.
      if (dir === join(server.contentDir, destPath)) continue;
      expect(existsSync(dir)).toBe(false);
    }
  });
});
