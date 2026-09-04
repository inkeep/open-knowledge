import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const copilotUserSkill = (name: string) => join(tmpHome, '.copilot', 'skills', name, 'SKILL.md');
const copilotProjectRootAtHome = (name: string) => join(tmpHome, '.github', 'skills', name);

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-copilot-root-home-'));
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

    expect(existsSync(copilotUserSkill(name))).toBe(true);
    expect(existsSync(copilotProjectRootAtHome(name))).toBe(false);
  });

  test('project→global move of a copilot-installed skill keeps copilot at the user root', async () => {
    const name = 'gh-copilot-moved';
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

    expect(existsSync(copilotUserSkill(name))).toBe(true);
    expect(existsSync(copilotProjectRootAtHome(name))).toBe(false);
  });
});
