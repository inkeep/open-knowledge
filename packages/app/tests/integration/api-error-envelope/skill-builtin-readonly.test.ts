/**
 * Integration coverage for OK's built-in `open-knowledge` project skill being
 * surfaced READ-ONLY through the skills API.
 *
 * The built-in skill is force-installed into the editor host dirs
 * (`.claude/skills/open-knowledge/`), NOT `.ok/skills`, so it is normally
 * invisible to the Skills UI. These tests write a fake on-disk projection into
 * the harness's project dir and assert:
 *   - `GET /api/skills` lists it as a `managed` entry (installed, host = claude).
 *   - `GET /api/skill` + `GET /api/skill-file` serve its SKILL.md + references
 *     read-only (from the host dir, not `.ok/skills`).
 *   - every mutation (PUT / POST rename / DELETE / install / PUT file) is refused
 *     with `urn:ok:error:reserved-doc-name` (the defense-in-depth server gate,
 *     independent of the UI hiding those controls).
 *   - a refused DELETE leaves the on-disk file intact.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ProblemDetailsSchema,
  SkillGetSuccessSchema,
  SkillsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

const SKILL_MD = `---
name: open-knowledge
description: The OpenKnowledge project skill agents load for this KB.
---

# Open Knowledge

Route reads and writes through the MCP tools.
`;
const REFERENCE_MD = '# Setup\n\nRun `ok init` first.\n';

let builtinSkillMd: string;

beforeAll(async () => {
  server = await createTestServer();
  // Fake the on-disk editor projection the reclaim/init path would install.
  const dir = join(server.contentDir, '.claude', 'skills', 'open-knowledge');
  mkdirSync(join(dir, 'references'), { recursive: true });
  builtinSkillMd = join(dir, 'SKILL.md');
  writeFileSync(builtinSkillMd, SKILL_MD, 'utf-8');
  writeFileSync(join(dir, 'references', 'setup.md'), REFERENCE_MD, 'utf-8');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('built-in open-knowledge skill: read-only surfacing', () => {
  test('GET /api/skills includes it as a managed entry', async () => {
    const res = await fetch(`${base()}/api/skills`);
    expect(res.status).toBe(200);
    const parsed = SkillsListSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const entry = parsed.data.skills.find((s) => s.name === 'open-knowledge');
    expect(entry).toBeDefined();
    expect(entry?.managed).toBe(true);
    expect(entry?.scope).toBe('project');
    expect(entry?.installed).toBe(true);
    expect(entry?.hosts).toContain('claude');
    expect(entry?.description).toBe('The OpenKnowledge project skill agents load for this KB.');
  });

  test('GET /api/skill serves its body + references from the host dir', async () => {
    const res = await fetch(`${base()}/api/skill?name=open-knowledge&scope=project`);
    expect(res.status).toBe(200);
    const parsed = SkillGetSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.skill.managed).toBe(true);
    expect(parsed.data.skill.body).toContain('Route reads and writes through the MCP tools.');
    const ref = parsed.data.skill.files?.find((f) => f.path === 'references/setup.md');
    expect(ref?.text).toContain('Run `ok init` first.');
  });

  test('GET /api/skill-file serves SKILL.md read-only (skill-dir root)', async () => {
    const res = await fetch(
      `${base()}/api/skill-file?name=open-knowledge&scope=project&path=SKILL.md`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text?: string };
    expect(body.text).toContain('# Open Knowledge');
  });

  test('GET /api/skill-file serves a reference read-only', async () => {
    const res = await fetch(
      `${base()}/api/skill-file?name=open-knowledge&scope=project&path=references/setup.md`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text?: string };
    expect(body.text).toContain('# Setup');
  });

  const expectReserved = async (res: Response) => {
    expect(res.status).toBe(400);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.type).toBe('urn:ok:error:reserved-doc-name');
  };

  test('PUT /api/skill is refused', async () => {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'open-knowledge',
        body: 'hijacked',
        frontmatter: { name: 'open-knowledge', description: 'hijacked' },
      }),
    });
    await expectReserved(res);
  });

  test('POST /api/skill rename is refused', async () => {
    const res = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', fromName: 'open-knowledge', toName: 'my-skill' }),
    });
    await expectReserved(res);
  });

  test('POST /api/skill/install is refused', async () => {
    const res = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', name: 'open-knowledge' }),
    });
    await expectReserved(res);
  });

  test('PUT /api/skill-file is refused', async () => {
    const res = await fetch(`${base()}/api/skill-file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name: 'open-knowledge',
        path: 'references/evil.md',
        content: 'x',
      }),
    });
    await expectReserved(res);
  });

  test('DELETE /api/skill is refused and leaves the on-disk file intact', async () => {
    const res = await fetch(`${base()}/api/skill?name=open-knowledge&scope=project`, {
      method: 'DELETE',
    });
    await expectReserved(res);
    expect(existsSync(builtinSkillMd)).toBe(true);
  });
});
