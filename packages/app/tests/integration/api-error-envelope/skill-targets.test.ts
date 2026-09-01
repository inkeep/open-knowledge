import { SkillTargetsGetSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
});

describe('skill-targets — detected set + machine default (store retirement)', () => {
  test('GET reports the detected set and folder states for both scopes', async () => {
    const res = await fetch(`${base()}/api/skill-targets`);
    expect(res.status).toBe(200);
    const parsed = SkillTargetsGetSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.configured).toBe(false);
    expect(Array.isArray(parsed.data.folders)).toBe(true);
    const scopes = new Set(parsed.data.folders?.map((f) => f.scope));
    expect(scopes.has('project')).toBe(true);
    expect(scopes.has('global')).toBe(true);
  });

  test('PUT with the retired userInstallMode field is rejected loudly (strict schema) → 400', async () => {
    const put = await fetch(`${base()}/api/skill-targets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userInstallMode: 'link' }),
    });
    expect(put.status).toBe(400);
  });

  test('PUT with the retired `targets` field is rejected loudly (strict schema) → 400', async () => {
    const res = await fetch(`${base()}/api/skill-targets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['claude'] }),
    });
    expect(res.status).toBe(400);
  });

  test('PUT with no action → 400', async () => {
    const res = await fetch(`${base()}/api/skill-targets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
