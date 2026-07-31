import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

/**
 * renaming a skill must MOVE it, not leave a copy of the old name
 * behind, and must keep the editors it occupied. Reproduces the reported flow:
 * create a project skill, install it to claude+cursor, rename foo→bar.
 *
 */
let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const HOST_DOTDIR = { claude: '.claude', cursor: '.cursor' } as const;
const editorDir = (editor: keyof typeof HOST_DOTDIR, name: string) =>
  join(server.contentDir, HOST_DOTDIR[editor], 'skills', name);
const editorCopy = (editor: keyof typeof HOST_DOTDIR, name: string) =>
  join(editorDir(editor, name), 'SKILL.md');

async function listNames(): Promise<string[]> {
  const parsed = SkillsListSuccessSchema.safeParse(
    await (await fetch(`${base()}/api/skills`)).json(),
  );
  if (!parsed.success) return [];
  return parsed.data.skills.map((s) => s.name);
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-skill-rename-home-'));
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('skill rename moves, never copies (PRD-7603)', () => {
  test('rename foo→bar: old name gone everywhere, new name keeps claude+cursor', async () => {
    expect(
      (
        await fetch(`${base()}/api/skill`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'project',
            name: 'foo',
            body: '## When\n\nDoing foo.',
            frontmatter: { name: 'foo', description: 'Use when doing foo.' },
          }),
        })
      ).status,
    ).toBe(200);

    const lockPath = join(server.contentDir, '.ok', 'skills-lock.json');
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          schema: 1,
          skills: {
            foo: {
              source: 'https://github.com/acme/skills',
              contentHash: 'upstream-hash',
              localHash: 'pre-rename-local-hash',
              importedAt: '2026-07-29T12:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(
      (
        await fetch(`${base()}/api/skill/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'project',
            name: 'foo',
            targets: ['claude', 'cursor'],
            linkMode: false,
          }),
        })
      ).status,
    ).toBe(200);
    expect(existsSync(editorCopy('claude', 'foo'))).toBe(true);
    expect(existsSync(editorCopy('cursor', 'foo'))).toBe(true);

    // Rename (the POST /api/skill fromName→toName the dialog uses).
    const rename = await fetch(`${base()}/api/skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', fromName: 'foo', toName: 'bar' }),
    });
    expect(rename.status).toBe(200);

    // No copy of the OLD name survives in ANY editor.
    expect(existsSync(editorCopy('claude', 'foo'))).toBe(false);
    expect(existsSync(editorCopy('cursor', 'foo'))).toBe(false);

    // The new name still occupies the editors foo held (rename ≠ uninstall).
    expect(existsSync(editorCopy('claude', 'bar'))).toBe(true);
    expect(existsSync(editorCopy('cursor', 'bar'))).toBe(true);
    expect(lstatSync(editorDir('cursor', 'bar')).isSymbolicLink()).toBe(false);

    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      skills: Record<string, { source: string; localHash?: string }>;
    };
    expect(lock.skills.foo).toBeUndefined();
    expect(lock.skills.bar?.source).toBe('https://github.com/acme/skills');
    expect(lock.skills.bar?.localHash).not.toBe('pre-rename-local-hash');

    // The list shows exactly one skill, `bar` — never both foo and bar.
    const names = await listNames();
    expect(names).toContain('bar');
    expect(names).not.toContain('foo');
    expect(names.filter((n) => n === 'bar')).toHaveLength(1);

    const listed = (await fetch(`${base()}/api/skills?scope=project`).then((r) => r.json())) as {
      skills: Array<{ name: string; origin?: { source: string } }>;
    };
    expect(listed.skills.find((skill) => skill.name === 'bar')?.origin?.source).toBe(
      'https://github.com/acme/skills',
    );
  });
});
