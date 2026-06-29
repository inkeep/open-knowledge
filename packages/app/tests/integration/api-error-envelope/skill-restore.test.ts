
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  HistorySuccessSchema,
  SkillGetSuccessSchema,
  SkillRestoreSuccessSchema,
} from '@inkeep/open-knowledge-core';

const SKILL_DOC_NAME = '.ok/skills/trip-log/SKILL';

import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;
const AGENT = { agentId: 'agent-test', agentName: 'Test Agent' };

const writeSkill = (body: string) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'trip-log',
      body,
      frontmatter: { name: 'trip-log', description: 'Use when logging a trip.' },
      ...AGENT,
    }),
  });

const getBody = async () => {
  const res = await fetch(`${base()}/api/skill?name=trip-log&scope=project`);
  const parsed = SkillGetSuccessSchema.safeParse(await res.json());
  return parsed.success ? parsed.data.skill.body : '';
};

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
});

describe('skill restore (R6)', () => {
  test('history → restore reverts the source to an earlier version', async () => {
    expect((await writeSkill('# Version ONE')).status).toBe(200);
    expect((await writeSkill('# Version TWO')).status).toBe(200);
    expect(await getBody()).toContain('Version TWO');

    const histRes = await fetch(
      `${base()}/api/history?docName=${encodeURIComponent(SKILL_DOC_NAME)}`,
    );
    expect(histRes.status).toBe(200);
    const hist = HistorySuccessSchema.safeParse(await histRes.json());
    expect(hist.success).toBe(true);
    if (!hist.success) return;
    expect(hist.data.entries.length).toBeGreaterThanOrEqual(2);
    const oldest = hist.data.entries[hist.data.entries.length - 1];
    expect(oldest?.sha).toMatch(/^[0-9a-f]{40}$/);

    const restoreRes = await fetch(`${base()}/api/skill/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'trip-log', version: oldest?.sha, ...AGENT }),
    });
    expect(restoreRes.status).toBe(200);
    const restored = SkillRestoreSuccessSchema.safeParse(await restoreRes.json());
    expect(restored.success).toBe(true);
    if (restored.success) expect(restored.data.restoredFiles).toContain('SKILL.md');

    expect(await getBody()).toContain('Version ONE');
    expect(await getBody()).not.toContain('Version TWO');
  });

  test('restore of a bogus version → 404', async () => {
    const res = await fetch(`${base()}/api/skill/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'trip-log', version: 'f'.repeat(40), ...AGENT }),
    });
    expect(res.status).toBe(404);
  });

  test('history for an unknown skill → 200 empty', async () => {
    const res = await fetch(
      `${base()}/api/history?docName=${encodeURIComponent('.ok/skills/ghost/SKILL')}`,
    );
    expect(res.status).toBe(200);
    const parsed = HistorySuccessSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.entries).toEqual([]);
  });
});
