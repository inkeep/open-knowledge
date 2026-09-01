import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { resolveDeckPath } from './slides-deck-path.ts';

let root: string;
let projectRoot: string;
let outside: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-deck-path-')));
  projectRoot = join(root, 'project');
  outside = join(root, 'outside');
  mkdirSync(join(projectRoot, 'decks'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(projectRoot, 'decks', 'talk.md'), '---\nslides: true\n---\n# Deck\n');
  writeFileSync(join(outside, 'secret.md'), '---\nslides: true\n---\n# Outside\n');
  symlinkSync(join(outside, 'secret.md'), join(projectRoot, 'decks', 'escape.md'));
  symlinkSync(join(outside, 'gone.md'), join(projectRoot, 'decks', 'broken.md'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const real = { platform: process.platform, realpath: (p: string) => realpathSync(p) };

describe('resolveDeckPath — admits a genuine in-project deck', () => {
  test('resolves a plain deck inside the project', () => {
    const result = resolveDeckPath({
      ...real,
      docPath: join(projectRoot, 'decks', 'talk.md'),
      projectRoot,
    });
    expect(result).toEqual({
      ok: true,
      resolvedDocPath: join(projectRoot, 'decks', 'talk.md'),
      projectRoot,
    });
  });

  test('admits a symlink whose target is ALSO inside the project', () => {
    const alias = join(projectRoot, 'decks', 'alias.md');
    symlinkSync(join(projectRoot, 'decks', 'talk.md'), alias);
    const result = resolveDeckPath({ ...real, docPath: alias, projectRoot });
    expect(result).toEqual({
      ok: true,
      resolvedDocPath: join(projectRoot, 'decks', 'talk.md'),
      projectRoot,
    });
  });
});

describe('resolveDeckPath — refuses an escape', () => {
  test('refuses an in-project symlink that resolves OUTSIDE the project', () => {
    const result = resolveDeckPath({
      ...real,
      docPath: join(projectRoot, 'decks', 'escape.md'),
      projectRoot,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-path' });
  });

  test('refuses a path plainly outside the project', () => {
    const result = resolveDeckPath({
      ...real,
      docPath: join(outside, 'secret.md'),
      projectRoot,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-path' });
  });

  test('refuses a broken symlink, carrying the OS code and not the path', () => {
    const result = resolveDeckPath({
      ...real,
      docPath: join(projectRoot, 'decks', 'broken.md'),
      projectRoot,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid-path');
    expect(result.cause?.code).toBe('ENOENT');
    expect(JSON.stringify(result)).not.toContain('broken.md');
  });

  test('refuses when the window has no bound project — nothing to contain against', () => {
    const result = resolveDeckPath({
      ...real,
      docPath: join(projectRoot, 'decks', 'talk.md'),
      projectRoot: undefined,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-path' });
  });

  test('refuses a relative path before it ever reaches the filesystem', () => {
    const result = resolveDeckPath({ ...real, docPath: 'decks/talk.md', projectRoot });
    expect(result).toEqual({ ok: false, reason: 'invalid-path' });
  });

  test.each([
    {
      name: 'resolved deck path',
      docPath: 'C:\\project\\decks\\talk.md',
      projectRoot: 'C:\\project',
      resolvedDocPath: 'C:\\project\\decks\\%CMDCMDLINE%.md',
    },
    {
      name: 'canonical project root',
      docPath: 'C:\\project\\decks\\talk.md',
      projectRoot: 'C:\\project%CMDCMDLINE%',
      resolvedDocPath: 'C:\\project%CMDCMDLINE%\\decks\\talk.md',
    },
    {
      name: 'quoted resolved deck path',
      docPath: 'C:\\project\\decks\\talk.md',
      projectRoot: 'C:\\project',
      resolvedDocPath: 'C:\\project\\decks\\talk"notes.md',
    },
    {
      name: 'quoted canonical project root',
      docPath: 'C:\\project\\decks\\talk.md',
      projectRoot: 'C:\\project"notes',
      resolvedDocPath: 'C:\\project"notes\\decks\\talk.md',
    },
  ])('refuses cmd.exe grammar in the post-realpath $name', (input) => {
    const result = resolveDeckPath({
      platform: 'win32',
      docPath: input.docPath,
      projectRoot: input.projectRoot,
      realpath: () => input.resolvedDocPath,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-path' });
  });

  test('surfaces a symlink loop as a refusal with its code', () => {
    const result = resolveDeckPath({
      platform: process.platform,
      docPath: join(projectRoot, 'decks', 'talk.md'),
      projectRoot,
      realpath: () => {
        throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      },
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-path',
      cause: { code: 'ELOOP' },
    });
  });
});
