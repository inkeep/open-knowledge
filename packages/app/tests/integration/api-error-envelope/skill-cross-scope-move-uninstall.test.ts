import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

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

const skillSrc = (scope: 'global' | 'project', name: string) =>
  scope === 'global'
    ? join(tmpHome, '.ok', 'skills', name)
    : join(server.contentDir, '.ok', 'skills', name);

const projectionDir = (
  scope: 'global' | 'project',
  editor: (typeof EDITORS)[number],
  name: string,
) =>
  scope === 'global'
    ? join(tmpHome, HOST_DOTDIR[editor], 'skills', name)
    : join(server.contentDir, HOST_DOTDIR[editor], 'skills', name);

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

    for (const e of EDITORS) {
      expect(existsSync(projectionDir('project', e, N))).toBe(false);
    }
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

    for (const e of EDITORS) {
      expect(existsSync(projectionDir('global', e, N))).toBe(false);
    }
    expect(existsSync(skillSrc('global', N))).toBe(false);
    expect(existsSync(join(skillSrc('project', N), 'SKILL.md'))).toBe(true);
    for (const e of EDITORS) {
      expect(existsSync(projectionDir('project', e, N))).toBe(false);
    }
  });
});
