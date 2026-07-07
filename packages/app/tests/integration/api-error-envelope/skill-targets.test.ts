/**
 * Narrow-integration test for the editable project skill-target set
 * (`GET` / `PUT /api/skill-targets`).
 *
 * Proves the headline requirement: changing the target set re-projects EVERY
 * managed skill — the authored skill AND OK's shipped `open-knowledge` bundle —
 * to the new editors, and reverse-projects from dropped ones, against a real
 * server (`projectDir === contentDir`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SkillTargetsGetSuccessSchema,
  SkillTargetsPutSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;
const hostSkill = (editorRoot: string, name: string) =>
  join(server.contentDir, editorRoot, 'skills', name);
const markerPath = () => join(server.contentDir, '.ok', 'local', 'installed-skills.json');

beforeAll(async () => {
  server = await createTestServer();
  // Author + install a skill into claude + cursor.
  await fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'trip-log',
      body: '# Steps',
      frontmatter: { name: 'trip-log', description: 'Use when logging a trip.' },
    }),
  });
  await fetch(`${base()}/api/skill/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'trip-log', targets: ['claude', 'cursor'] }),
  });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
});

describe('skill-targets — change set re-projects authored skills + OK bundle', () => {
  test('GET reports the effective set (unconfigured before any PUT)', async () => {
    const res = await fetch(`${base()}/api/skill-targets`);
    expect(res.status).toBe(200);
    const parsed = SkillTargetsGetSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.configured).toBe(false);
  });

  test('PUT narrows targets → skill + bundle drop from cursor, kept in claude', async () => {
    // Precondition: installed into both claude + cursor.
    expect(existsSync(join(hostSkill('.cursor', 'trip-log'), 'SKILL.md'))).toBe(true);

    const res = await fetch(`${base()}/api/skill-targets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['claude'] }),
    });
    expect(res.status).toBe(200);
    const parsed = SkillTargetsPutSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.targets).toEqual(['claude']);
      const tripLog = parsed.data.reprojected.find((r) => r.name === 'trip-log');
      expect(tripLog?.hosts).toEqual(['claude']);
      // OK's shipped bundle followed the set into claude.
      expect(parsed.data.bundleHosts).toEqual(['claude']);
    }

    // Authored skill: present in claude, gone from cursor.
    expect(existsSync(join(hostSkill('.claude', 'trip-log'), 'SKILL.md'))).toBe(true);
    expect(existsSync(hostSkill('.cursor', 'trip-log'))).toBe(false);

    // Shipped bundle: present in claude, gone from cursor.
    expect(existsSync(join(hostSkill('.claude', 'open-knowledge'), 'SKILL.md'))).toBe(true);
    expect(existsSync(hostSkill('.cursor', 'open-knowledge'))).toBe(false);

    // Marker host set synced to the new targets.
    const marker = JSON.parse(readFileSync(markerPath(), 'utf-8')) as {
      skills: Record<string, { hosts: string[] }>;
    };
    expect(marker.skills['trip-log']?.hosts).toEqual(['claude']);
  });

  test('GET now reports the committed set', async () => {
    const res = await fetch(`${base()}/api/skill-targets`);
    const parsed = SkillTargetsGetSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.configured).toBe(true);
      expect(parsed.data.targets).toEqual(['claude']);
    }
  });

  test('PUT widening targets → skill + bundle re-appear in cursor', async () => {
    const res = await fetch(`${base()}/api/skill-targets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['claude', 'cursor'] }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(hostSkill('.cursor', 'trip-log'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(hostSkill('.cursor', 'open-knowledge'), 'SKILL.md'))).toBe(true);
  });

  test('PUT rejects an unknown editor id (.strict enum) → 400', async () => {
    const res = await fetch(`${base()}/api/skill-targets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['claude', 'vscode'] }),
    });
    expect(res.status).toBe(400);
  });
});
