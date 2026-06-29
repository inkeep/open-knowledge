
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProblemDetailsSchema, SkillInstallSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

const putSkill = (name: string, frontmatter = `name: ${name}\ndescription: Use when testing.`) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, body: '# Steps', frontmatter: parseFm(frontmatter) }),
  });

function parseFm(fm: string): { name: string; description: string } {
  const name = /name:\s*(.+)/.exec(fm)?.[1]?.trim() ?? '';
  const description = /description:\s*(.+)/.exec(fm)?.[1]?.trim() ?? '';
  return { name, description };
}

const installSkill = (body: Record<string, unknown>) =>
  fetch(`${base()}/api/skill/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const hostSkillMd = (editorRoot: string, name: string) =>
  join(server.contentDir, editorRoot, 'skills', name, 'SKILL.md');
const markerPath = () => join(server.contentDir, '.ok', 'local', 'installed-skills.json');

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
});

describe('skill install-projection lifecycle', () => {
  test('install projects verbatim into explicit targets + records the marker', async () => {
    expect((await putSkill('trip-log')).status).toBe(200);

    const res = await installSkill({ name: 'trip-log', targets: ['claude', 'cursor'] });
    expect(res.status).toBe(200);
    const parsed = SkillInstallSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hosts.sort()).toEqual(['claude', 'cursor']);
      expect(parsed.data.scripts).toBe(false);
    }

    expect(existsSync(hostSkillMd('.claude', 'trip-log'))).toBe(true);
    expect(existsSync(hostSkillMd('.cursor', 'trip-log'))).toBe(true);
    expect(readFileSync(hostSkillMd('.claude', 'trip-log'), 'utf-8')).toContain('# Steps');

    const marker = JSON.parse(readFileSync(markerPath(), 'utf-8')) as {
      skills: Record<string, { hosts: string[]; scope: string }>;
    };
    expect(marker.skills['trip-log']?.hosts.sort()).toEqual(['claude', 'cursor']);
    expect(marker.skills['trip-log']?.scope).toBe('project');
  });

  test('delete reverse-projects (uninstall) + drops the marker entry', async () => {
    const res = await fetch(`${base()}/api/skill?name=trip-log&scope=project`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(existsSync(hostSkillMd('.claude', 'trip-log'))).toBe(false);
    expect(existsSync(hostSkillMd('.cursor', 'trip-log'))).toBe(false);
    const marker = JSON.parse(readFileSync(markerPath(), 'utf-8')) as {
      skills: Record<string, unknown>;
    };
    expect(marker.skills['trip-log']).toBeUndefined();
  });

  test('rename of an installed skill carries the install-state to the new name', async () => {
    expect((await putSkill('rename-me')).status).toBe(200);
    expect((await installSkill({ name: 'rename-me', targets: ['claude'] })).status).toBe(200);

    const readMarker = () =>
      JSON.parse(readFileSync(markerPath(), 'utf-8')) as {
        skills: Record<string, { hosts: string[] }>;
      };
    expect(readMarker().skills['rename-me']?.hosts).toEqual(['claude']);
    expect(existsSync(hostSkillMd('.claude', 'rename-me'))).toBe(true);

    const moveRes = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromName: 'rename-me', toName: 'renamed-ok', scope: 'project' }),
    });
    expect(moveRes.status).toBe(200);

    const after = readMarker();
    expect(after.skills['rename-me']).toBeUndefined();
    expect(after.skills['renamed-ok']?.hosts).toEqual(['claude']);
    expect(existsSync(hostSkillMd('.claude', 'rename-me'))).toBe(false);
    expect(existsSync(hostSkillMd('.claude', 'renamed-ok'))).toBe(true);
  });

  test('install of a missing skill → 404', async () => {
    const res = await installSkill({ name: 'ghost', targets: ['claude'] });
    expect(res.status).toBe(404);
  });

  test('install refuses the reserved open-knowledge* prefix → 400', async () => {
    expect((await putSkill('open-knowledge-mine')).status).toBe(200);
    const res = await installSkill({ name: 'open-knowledge-mine', targets: ['claude'] });
    expect(res.status).toBe(400);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success && parsed.data.title.includes('reserved')).toBe(true);
  });

  test('install refuses a source with git conflict markers → 400', async () => {
    const dir = join(server.contentDir, '.ok', 'skills', 'conflicted');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: conflicted\ndescription: d\n---\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n',
      'utf-8',
    );
    const res = await installSkill({ name: 'conflicted', targets: ['claude'] });
    expect(res.status).toBe(400);
    expect(existsSync(hostSkillMd('.claude', 'conflicted'))).toBe(false);
  });

  test('install with no targets + none configured → 200 with a warning, nothing projected', async () => {
    expect((await putSkill('lonely')).status).toBe(200);
    const res = await installSkill({ name: 'lonely' });
    expect(res.status).toBe(200);
    const parsed = SkillInstallSuccessSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hosts).toEqual([]);
      expect(parsed.data.warnings.some((w) => w.includes('No project-configured editors'))).toBe(
        true,
      );
    }
  });
});
