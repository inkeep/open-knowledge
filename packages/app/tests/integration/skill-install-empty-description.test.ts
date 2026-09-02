import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillInstallSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const put = (scope: string, name: string, description: string) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name, frontmatter: { name, description }, body: '# x' }),
  });
const install = (scope: string, name: string, targets: string[]) =>
  fetch(`${base()}/api/skill/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name, targets }),
  });

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-install-emptydesc-home-'));
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('install with an empty description (PRD-7596)', () => {
  test('installs with a no-description warning instead of a hard error', async () => {
    expect((await put('project', 'nodesc', '')).status).toBe(200);
    const res = await install('project', 'nodesc', ['claude']);
    expect(res.status).toBe(200);
    const parsed = SkillInstallSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.hosts).toContain('claude');
    expect(parsed.data.warningCodes).toContain('no-description');
  });

  test('re-installing an already-installed target is a clean no-op success', async () => {
    expect((await put('project', 'withdesc', 'A real description.')).status).toBe(200);
    expect((await install('project', 'withdesc', ['claude'])).status).toBe(200);
    const again = await install('project', 'withdesc', ['claude']);
    expect(again.status).toBe(200);
    const parsed = SkillInstallSuccessSchema.safeParse(await again.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.hosts).toContain('claude');
    expect(parsed.data.warningCodes).not.toContain('no-description');
  });
});
