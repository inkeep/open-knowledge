import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ProblemDetailsSchema,
  SkillDeleteSuccessSchema,
  SkillGetSuccessSchema,
  SkillMoveSuccessSchema,
  SkillPutSuccessSchema,
  SkillsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

const putSkill = (body: Record<string, unknown>) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
});

describe('skill envelope (RFC 9457) + CRUD lifecycle', () => {
  test('PUT happy path → 200 flat success body, created:true', async () => {
    const res = await putSkill({
      name: 'trip-log',
      body: '# Steps\n\nLog the trip.',
      frontmatter: { name: 'trip-log', description: 'Use when logging a fishing trip.' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = await res.json();
    const parsed = SkillPutSuccessSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.created).toBe(true);
      expect(parsed.data.path).toBe('trip-log/SKILL.md');
    }
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('re-PUT the same skill → created:false (overwrite)', async () => {
    const res = await putSkill({
      name: 'trip-log',
      body: '# Steps v2',
      frontmatter: { name: 'trip-log', description: 'Use when logging a fishing trip.' },
    });
    expect(res.status).toBe(200);
    const parsed = SkillPutSuccessSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.created).toBe(false);
  });

  test('PUT with an XML tag in description → 400 invalid-request', async () => {
    const res = await putSkill({
      name: 'bad-desc',
      body: 'x',
      frontmatter: { name: 'bad-desc', description: 'Use when <folder> appears.' },
    });
    expect(res.status).toBe(400);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.type).toBe('urn:ok:error:invalid-request');
  });

  test('PUT with name ≠ frontmatter.name → 400', async () => {
    const res = await putSkill({
      name: 'trip-log',
      body: 'x',
      frontmatter: { name: 'other', description: 'mismatch' },
    });
    expect(res.status).toBe(400);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.type).toBe('urn:ok:error:invalid-request');
  });

  test('PUT with an injected `version` key → 400 (.strict frontmatter purity)', async () => {
    const res = await putSkill({
      name: 'versioned',
      body: 'x',
      frontmatter: { name: 'versioned', description: 'has version', version: '1.0' },
    });
    expect(res.status).toBe(400);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.type).toBe('urn:ok:error:invalid-request');
  });

  test('PUT with global scope → 200 (global store at <home>/.ok/skills)', async () => {
    const res = await putSkill({
      scope: 'global',
      name: 'mine',
      body: 'x',
      frontmatter: { name: 'mine', description: 'global scope' },
    });
    expect(res.status).toBe(200);
  });

  test('GET one returns the skill payload', async () => {
    const res = await fetch(`${base()}/api/skill?name=trip-log&scope=project`);
    expect(res.status).toBe(200);
    const parsed = SkillGetSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skill.name).toBe('trip-log');
      expect(parsed.data.skill.frontmatter.description).toBe('Use when logging a fishing trip.');
    }
  });

  test('GET /api/skills lists the written skill', async () => {
    const res = await fetch(`${base()}/api/skills`);
    expect(res.status).toBe(200);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const entry = parsed.data.skills.find((s) => s.name === 'trip-log');
      expect(entry).toBeDefined();
      expect(entry?.installed).toBe(false);
      expect(entry?.hosts).toEqual([]);
    }
  });

  test('POST rename keeps SKILL.md name in sync with the new directory', async () => {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', fromName: 'trip-log', toName: 'voyage-log' }),
    });
    expect(res.status).toBe(200);
    const parsed = SkillMoveSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);

    const get = await fetch(`${base()}/api/skill?name=voyage-log&scope=project`);
    expect(get.status).toBe(200);
    const got = SkillGetSuccessSchema.safeParse(await get.json());
    expect(got.success && got.data.skill.frontmatter.name).toBe('voyage-log');

    const old = await fetch(`${base()}/api/skill?name=trip-log&scope=project`);
    expect(old.status).toBe(404);
  });

  test('DELETE happy path (existed=true, then false)', async () => {
    const first = await fetch(`${base()}/api/skill?name=voyage-log&scope=project`, {
      method: 'DELETE',
    });
    expect(first.status).toBe(200);
    const parsed = SkillDeleteSuccessSchema.safeParse(await first.json());
    expect(parsed.success && parsed.data.existed).toBe(true);

    const second = await fetch(`${base()}/api/skill?name=voyage-log&scope=project`, {
      method: 'DELETE',
    });
    expect(second.status).toBe(200);
    const parsed2 = SkillDeleteSuccessSchema.safeParse(await second.json());
    expect(parsed2.success && parsed2.data.existed).toBe(false);
  });

  test('GET on a missing skill → 404 problem+json', async () => {
    const res = await fetch(`${base()}/api/skill?name=ghost&scope=project`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.status).toBe(404);
  });

  test('method-not-allowed on PATCH → 405 + Allow header', async () => {
    const res = await fetch(`${base()}/api/skill`, { method: 'PATCH' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, PUT, POST, DELETE');
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.type).toBe('urn:ok:error:method-not-allowed');
  });
});
