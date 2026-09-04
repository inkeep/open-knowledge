import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const EDITORS = ['claude', 'cursor', 'codex'] as const;
const HOST_DOTDIR: Record<(typeof EDITORS)[number], string> = {
  claude: '.claude',
  cursor: '.cursor',
  codex: '.codex',
};

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: Use when logging a trip.\n---\n\n## When\n\nLogging a trip.\n`;

function seedInPlaceAcrossEditors(root: string, name: string): void {
  for (const e of EDITORS) {
    const dir = join(root, HOST_DOTDIR[e], 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(name));
  }
}

const globalProjection = (editor: (typeof EDITORS)[number], name: string) =>
  join(tmpHome, HOST_DOTDIR[editor], 'skills', name);

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-scope-move-hosts-home-'));
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('scope move preserves the editor host set (PRD-7601)', () => {
  test('project→global re-installs into every editor the scan-only skill occupied', async () => {
    const name = 'trip-logger';
    seedInPlaceAcrossEditors(server.contentDir, name);

    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(res.status).toBe(200);

    for (const e of EDITORS) {
      expect(existsSync(join(globalProjection(e, name), 'SKILL.md'))).toBe(true);
    }

    for (const e of EDITORS) {
      expect(existsSync(join(server.contentDir, HOST_DOTDIR[e], 'skills', name))).toBe(false);
    }
  });

  test('project→global preserves hosts through the REAL install path (marker-backed)', async () => {
    const name = 'trip-logger-installed';
    expect(
      (
        await fetch(`${base()}/api/skill`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'project',
            name,
            body: '## When\n\nLogging a trip.',
            frontmatter: { name, description: 'Use when logging a trip.' },
          }),
        })
      ).status,
    ).toBe(200);
    const installed = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', name, targets: ['claude', 'cursor'] }),
    });
    expect(installed.status).toBe(200);
    for (const e of ['claude', 'cursor'] as const) {
      expect(existsSync(join(server.contentDir, HOST_DOTDIR[e], 'skills', name, 'SKILL.md'))).toBe(
        true,
      );
    }

    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(res.status).toBe(200);

    for (const e of ['claude', 'cursor'] as const) {
      expect(existsSync(join(globalProjection(e, name), 'SKILL.md'))).toBe(true);
    }
  });

  test('project→global materializes the FOLDER-symlink audience as real installs', async () => {
    const name = 'trip-logger-linked';
    const agentsSkills = join(server.contentDir, '.agents', 'skills');
    mkdirSync(join(agentsSkills, name), { recursive: true });
    writeFileSync(join(agentsSkills, name, 'SKILL.md'), SKILL_MD(name));
    for (const e of ['claude', 'cursor'] as const) {
      mkdirSync(join(server.contentDir, HOST_DOTDIR[e]), { recursive: true });
      const link = join(server.contentDir, HOST_DOTDIR[e], 'skills');
      rmSync(link, { recursive: true, force: true });
      symlinkSync(agentsSkills, link, 'dir');
    }

    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(res.status).toBe(200);

    for (const e of ['claude', 'cursor'] as const) {
      expect(lstatSync(join(tmpHome, HOST_DOTDIR[e], 'skills')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(globalProjection(e, name), 'SKILL.md'))).toBe(true);
    }
  });
});
