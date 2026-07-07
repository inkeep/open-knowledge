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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

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

/** Source skills root for a scope (where `.ok/skills/<name>/` lives). */
const skillSrc = (scope: 'global' | 'project', name: string) =>
  scope === 'global'
    ? join(tmpHome, '.ok', 'skills', name)
    : join(server.contentDir, '.ok', 'skills', name);

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
async function moveCrossScope(from: 'global' | 'project', to: 'global' | 'project', name: string) {
  expect((await putSkill(to, name)).status).toBe(200);
  expect((await delSkill(from, name)).status).toBe(200);
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-xscope-uninstall-home-'));
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

    await moveCrossScope('global', 'project', N);

    // Every global-scope source projection is torn down (no orphans).
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('global', e, N))).toBe(false);
    }
    // Source dir gone; destination exists as an un-projected Draft.
    expect(existsSync(skillSrc('global', N))).toBe(false);
    expect(existsSync(join(skillSrc('project', N), 'SKILL.md'))).toBe(true);
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('project', e, N))).toBe(false);
    }
  });
});
