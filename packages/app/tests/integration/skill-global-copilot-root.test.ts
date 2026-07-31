import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

/**
 * at GLOBAL scope, projecting a skill to Copilot must target its USER
 * root (`~/.copilot/skills`), not its PROJECT root (`~/.github/skills`). The bug
 * was that `skillHostDir`/`projectSkill` always used `EDITOR_PROJECT_SKILL_ROOT`,
 * so a global install/move to Copilot landed in `~/.github/skills` while the scan
 * + menu looked at `~/.copilot` — silently dropping it.
 *
 * `configHomedirOverride` routes global-scope writes to a TEMP home, so this test
 * never touches the real `$HOME`.
 *
 */
let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const copilotUserSkill = (name: string) => join(tmpHome, '.copilot', 'skills', name, 'SKILL.md');
const copilotProjectRootAtHome = (name: string) => join(tmpHome, '.github', 'skills', name);

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-copilot-root-home-'));
  // `.copilot` present so the editor is a detected global host; `.agents` hub for
  // a vendor-neutral global source.
  mkdirSync(join(tmpHome, '.copilot', 'skills'), { recursive: true });
  mkdirSync(join(tmpHome, '.agents', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('global Copilot projection uses the user root (PRD-7620)', () => {
  test('global install to copilot lands in ~/.copilot/skills, not ~/.github/skills', async () => {
    const name = 'gh-copilot-global';
    expect(
      (
        await fetch(`${base()}/api/skill`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'global',
            name,
            frontmatter: { name, description: 'Global copilot skill.' },
            body: '# G',
          }),
        })
      ).status,
    ).toBe(200);

    const install = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', name, targets: ['copilot'] }),
    });
    expect(install.status).toBe(200);

    // Copilot's USER root, not its project root reused at home.
    expect(existsSync(copilotUserSkill(name))).toBe(true);
    expect(existsSync(copilotProjectRootAtHome(name))).toBe(false);
  });

  test('project→global move of a copilot-installed skill keeps copilot at the user root', async () => {
    const name = 'gh-copilot-moved';
    // Seed a project skill installed into copilot's PROJECT root (.github/skills).
    const projCopilot = join(server.contentDir, '.github', 'skills', name);
    mkdirSync(projCopilot, { recursive: true });
    writeFileSync(
      join(projCopilot, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Move me.\n---\n\n# M`,
    );

    const res = await fetch(`${base()}/api/skill/move-scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(res.status).toBe(200);

    // Copilot survives the move at its global USER root.
    expect(existsSync(copilotUserSkill(name))).toBe(true);
    expect(existsSync(copilotProjectRootAtHome(name))).toBe(false);
  });
});
