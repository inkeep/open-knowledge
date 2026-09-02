import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestServer, HARNESS_BOOT_TIMEOUT_MS, type TestServer } from '../test-harness.ts';

let server: TestServer;
let tmpHome: string;

const base = () => server.baseUrl;

const putSkill = (scope: 'global' | 'project', name: string) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      name,
      body: '## When\n\nMoving a skill whose source lives elsewhere.',
      frontmatter: { name, description: 'Use when testing symlinked sources.' },
    }),
  });

const moveScope = (name: string, fromScope: string, toScope: string) =>
  fetch(`${base()}/api/skill/move-scope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, fromScope, toScope }),
  });

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-move-symlink-home-'));
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterEach(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('cross-scope move with a symlinked canonical', () => {
  test('lands real bytes at the destination, not a link back to the source', async () => {
    const N = 'symlinked-source-probe';
    const put = await putSkill('global', N);
    expect(put.status).toBe(200);
    const { path: createdRel } = (await put.json()) as { path: string };
    const created = join(tmpHome, createdRel.replace(/\/SKILL\.md$/, ''));
    expect(existsSync(join(created, 'SKILL.md'))).toBe(true);
    const elsewhere = join(tmpHome, 'elsewhere', N);
    rmSync(join(tmpHome, 'elsewhere'), { recursive: true, force: true });
    mkdirSync(join(tmpHome, 'elsewhere'), { recursive: true });
    renameSync(created, elsewhere);
    symlinkSync(elsewhere, created, 'dir');
    expect(lstatSync(created).isSymbolicLink()).toBe(true);

    const res = await moveScope(N, 'global', 'project');
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    const dest = join(server.contentDir, path);

    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toContain('Moving a skill whose source');

    expect(existsSync(created)).toBe(false);
    expect(existsSync(elsewhere)).toBe(false);

    rmSync(elsewhere, { recursive: true, force: true });
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toContain('Moving a skill whose source');
  });
});
