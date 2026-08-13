/**
 * Cross-scope move when the skill's canonical dir is a SYMLINK.
 *
 * The reported failure: a skill whose `source` had been pointed at another
 * location was moved global→project. The destination came out as a link back to
 * the source tree, the move's own next step deleted that tree, and every path in
 * the new scope dangled at once — surfacing as `Broken/cyclic symlink at
 * .agents/skills/<name>` and a 500 from the destination post-condition.
 *
 * Two causes, both covered here: `resolveSkillDirForRead` answers "where is this
 * skill found" (by root precedence) and never realpaths, so the elected path can
 * itself be a link; and `cpSync` defaults to `dereference: false`, so copying it
 * copies the link rather than the bytes. A move must relocate the real tree.
 */
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
  // Adopt a harness in the throwaway home. A caller-supplied
  // `configHomedirOverride` owns its own host set, and skill destinations
  // resolve via `resolveDefaultSkillHomeRel`, which refuses (400
  // `NO_USABLE_SKILL_HOME`) when the home has adopted none — OK never creates
  // one on the user's behalf.
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
    // Take the landing path from the server — the default skill home depends on
    // which roots exist, so hardcoding it is wrong on some machines.
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

    // The destination is a real directory holding real bytes — NOT a pointer.
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toContain('Moving a skill whose source');

    // A move must not leave its bytes at the origin. The elected occurrence is
    // the symlink, so deleting only that root leaves the real tree behind and
    // the skill reappears in the source scope — a copy wearing a move's name.
    expect(existsSync(created)).toBe(false);
    expect(existsSync(elsewhere)).toBe(false);

    // And it survives the original tree going away — the property the dangling
    // links lacked. Without dereference this file would already be unreadable.
    rmSync(elsewhere, { recursive: true, force: true });
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toContain('Moving a skill whose source');
  });
});
