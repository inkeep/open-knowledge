import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPENKNOWLEDGE_SKILLS_REPO,
  ProblemDetailsSchema,
  SkillGetSuccessSchema,
  SkillsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
    expect(entry?.origin?.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
    expect(entry?.origin?.skill).toBe('open-knowledge');
    expect(entry?.origin?.autoUpdate).toBe(false);
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

  test('rename TO a runtime name is refused (squat guard); rename FROM is an ordinary fork-away', async () => {
    const squat = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', fromName: 'authored', toName: 'open-knowledge' }),
    });
    expect([400, 409]).toContain(squat.status);

    const away = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        fromName: 'open-knowledge',
        toName: 'my-own-guide',
      }),
    });
    expect(away.status).toBe(200);
    const restored = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        fromName: 'my-own-guide',
        toName: 'open-knowledge',
      }),
    });
    expect([400, 409]).toContain(restored.status);
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

  test('DELETE /api/skill succeeds — lifecycle is ordinary (content is what is protected)', async () => {
    const res = await fetch(`${base()}/api/skill?name=my-own-guide&scope=project`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
  });
});
