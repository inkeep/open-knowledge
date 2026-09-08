import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const BUILTIN = 'open-knowledge-discovery';

function seedBuiltin(rootRel: string): void {
  const dir = join(tmpHome, ...rootRel.split('/'), BUILTIN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${BUILTIN}\ndescription: Built-in discovery skill.\n---\n\n# D\n`,
  );
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-builtin-global-roots-'));
  seedBuiltin('.gemini/skills');
  seedBuiltin('.lmstudio/skills');
  seedBuiltin('.copilot/skills');
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('built-in skills resolve from the user roots at global scope', () => {
  test('its SKILL.md opens — the read resolves through a user-only root', async () => {
    const res = await fetch(`${base()}/api/skill?scope=global&name=${encodeURIComponent(BUILTIN)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skill?: { name?: string } };
    expect(body.skill?.name).toBe(BUILTIN);
  });

  test('it carries its skills.sh origin, so an Update can be offered', async () => {
    const res = await fetch(`${base()}/api/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills?: Array<{
        name: string;
        scope: string;
        hosts?: string[];
        origin?: { source?: string };
      }>;
    };
    const row = body.skills?.find((s) => s.name === BUILTIN && s.scope === 'global');
    expect(row).toBeDefined();
    expect(row?.origin?.source).toBe('inkeep/open-knowledge-skills');
    expect([...(row?.hosts ?? [])].sort()).toEqual(['antigravity', 'copilot', 'lm-studio']);
  });
});
