import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ProblemDetailsSchema,
  SeedInstallPackSkillSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
  const platformSkillDir = join(server.contentDir, '.claude', 'skills', 'open-knowledge');
  mkdirSync(platformSkillDir, { recursive: true });
  writeFileSync(
    join(platformSkillDir, 'SKILL.md'),
    '---\nname: open-knowledge\ndescription: project skill\n---\n',
    'utf-8',
  );
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('seed-install-pack-skill envelope', () => {
  test('installs only the requested pack skill and returns its creation state', async () => {
    const configPath = join(server.contentDir, '.ok', 'config.yml');
    const configBefore = readFileSync(configPath);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/seed/install-pack-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packId: 'okf' }),
    });

    expect(res.status).toBe(200);
    const parsed = SeedInstallPackSkillSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        installedHosts: ['Claude Code'],
        skills: [{ name: 'okf-knowledge-base', created: true }],
      });
    }
    expect(
      existsSync(join(server.contentDir, '.claude', 'skills', 'okf-knowledge-base', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(server.contentDir, 'index.md'))).toBe(false);
    expect(readFileSync(configPath)).toEqual(configBefore);
  });

  test('rejects an unknown pack id with problem details', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/seed/install-pack-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packId: 'not-a-pack' }),
    });

    expect(res.status).toBe(400);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
  });

  test('method-not-allowed on GET advertises POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/seed/install-pack-skill`);

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
