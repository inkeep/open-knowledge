import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BASE16_SLOTS, type Base16Scheme, base16ToYaml } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { savedThemesDir, scanSavedThemes } from './saved-themes-store.ts';
import { deleteSavedTheme, saveSavedTheme, updateSavedTheme } from './saved-themes-write.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-saved-themes-write-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A complete, valid scheme: sixteen distinct `#rrggbb` slots. */
function scheme(name: string, variant: 'dark' | 'light' = 'dark'): Base16Scheme {
  const palette = Object.fromEntries(
    BASE16_SLOTS.map((slot, i) => {
      const byte = (i * 16).toString(16).padStart(2, '0');
      return [slot, `#${byte}${byte}${byte}`];
    }),
  ) as Base16Scheme['palette'];
  return { name, variant, palette };
}

function storeFiles(): string[] {
  const dir = savedThemesDir(home);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function storeLockPath(baseDir: string): string {
  const rootKey = createHash('sha256')
    .update(resolve(savedThemesDir(home)))
    .digest('hex')
    .slice(0, 24);
  return join(baseDir, `saved-themes-${rootKey}.lock`);
}

async function withContendedStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = join(home, '.ok');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = storeLockPath(lockDir);
  writeFileSync(lockPath, '', { flag: 'wx', mode: 0o600 });
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

test('the user-owned store lock serializes save, update, and delete', async () => {
  const dir = savedThemesDir(home);
  mkdirSync(dir, { recursive: true });
  const updatePath = join(dir, 'update.yaml');
  const deletePath = join(dir, 'delete.yaml');
  const updateBytes = base16ToYaml(scheme('Update original'));
  const deleteBytes = base16ToYaml(scheme('Delete original'));
  writeFileSync(updatePath, updateBytes);
  writeFileSync(deletePath, deleteBytes);

  const results = await withContendedStoreLock(() =>
    Promise.all([
      saveSavedTheme({
        name: 'new-theme',
        scheme: scheme('New theme'),
        homedirOverride: home,
        lockTimeoutMs: 250,
      }),
      updateSavedTheme({
        id: 'saved-update',
        scheme: scheme('Update revised'),
        homedirOverride: home,
        lockTimeoutMs: 250,
      }),
      deleteSavedTheme({
        id: 'saved-delete',
        homedirOverride: home,
        lockTimeoutMs: 250,
      }),
    ]),
  );

  expect(results).toEqual([
    { ok: false, code: 'lock-timeout' },
    { ok: false, code: 'lock-timeout' },
    { ok: false, code: 'lock-timeout' },
  ]);
  expect(readFileSync(updatePath, 'utf-8')).toBe(updateBytes);
  expect(readFileSync(deletePath, 'utf-8')).toBe(deleteBytes);
  expect(storeFiles()).toEqual(['delete.yaml', 'update.yaml']);
});

test('a preclaimed legacy shared-temp lock cannot block saved-theme writes', async () => {
  const rootKey = createHash('sha256')
    .update(resolve(savedThemesDir(home)))
    .digest('hex')
    .slice(0, 24);
  const legacyLockPath = join(tmpdir(), `ok-saved-themes-${rootKey}.lock`);
  writeFileSync(legacyLockPath, '', { flag: 'wx', mode: 0o600 });

  try {
    await expect(
      saveSavedTheme({
        name: 'not-temp-locked',
        scheme: scheme('Not temp locked'),
        homedirOverride: home,
        lockTimeoutMs: 100,
      }),
    ).resolves.toEqual({
      ok: true,
      id: 'saved-not-temp-locked',
      filename: 'not-temp-locked.yaml',
    });
  } finally {
    rmSync(legacyLockPath, { force: true });
  }
});

describe('saveSavedTheme', () => {
  test('writes one scheme file, derives the namespaced id, and creates the store lazily', async () => {
    expect(existsSync(savedThemesDir(home))).toBe(false);

    const result = await saveSavedTheme({
      name: 'midnight',
      scheme: scheme('Midnight'),
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: true, id: 'saved-midnight', filename: 'midnight.yaml' });
    expect(storeFiles()).toEqual(['midnight.yaml']);
  });

  test('derives storage identity from a human-facing name without changing its display name', async () => {
    const result = await saveSavedTheme({
      name: "John's theme",
      scheme: scheme("John's theme"),
      homedirOverride: home,
    });

    expect(result).toEqual({
      ok: true,
      id: 'saved-johns-theme',
      filename: 'johns-theme.yaml',
    });
    const [entry] = scanSavedThemes({ homedirOverride: home }).entries;
    expect(entry).toMatchObject({
      ok: true,
      id: 'saved-johns-theme',
      scheme: { name: "John's theme" },
    });
  });

  test('can restore a deleted hand-dropped theme with its original .yml extension', async () => {
    const result = await saveSavedTheme({
      name: 'terse',
      scheme: scheme('Terse'),
      extension: '.yml',
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: true, id: 'saved-terse', filename: 'terse.yml' });
    expect(storeFiles()).toEqual(['terse.yml']);
  });

  test('the saved bytes parse back through the read path as a usable entry', async () => {
    await saveSavedTheme({
      name: 'aurora',
      scheme: scheme('Aurora', 'light'),
      homedirOverride: home,
    });

    // The write path and the read path agree — a saved theme lists as `ok`.
    const [entry] = scanSavedThemes({ homedirOverride: home }).entries;
    expect(entry).toMatchObject({ ok: true, id: 'saved-aurora', filename: 'aurora.yaml' });
    if (entry?.ok) {
      expect(entry.scheme.name).toBe('Aurora');
      expect(entry.scheme.variant).toBe('light');
      expect(Object.keys(entry.scheme.palette)).toHaveLength(16);
    }
  });

  test('refuses a name already taken and writes nothing', async () => {
    await saveSavedTheme({ name: 'dup', scheme: scheme('First'), homedirOverride: home });
    const before = readFileSync(join(savedThemesDir(home), 'dup.yaml'), 'utf-8');

    const result = await saveSavedTheme({
      name: 'dup',
      scheme: scheme('Second'),
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: false, code: 'name-taken' });
    // The existing file is untouched — a collision never overwrites prior work.
    expect(readFileSync(join(savedThemesDir(home), 'dup.yaml'), 'utf-8')).toBe(before);
    expect(storeFiles()).toEqual(['dup.yaml']);
  });

  test('serializes concurrent saves so exactly one writer claims a name', async () => {
    const results = await Promise.all([
      saveSavedTheme({ name: 'race', scheme: scheme('First'), homedirOverride: home }),
      saveSavedTheme({ name: 'race', scheme: scheme('Second'), homedirOverride: home }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: 'name-taken' }]);
    expect(storeFiles()).toEqual(['race.yaml']);
  });

  test('a name colliding across extensions (.yml vs .yaml) is still refused', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    // A hand-dropped `.yml` file establishes the identity `saved-terse`.
    writeFileSync(join(dir, 'terse.yml'), 'placeholder');

    const result = await saveSavedTheme({
      name: 'terse',
      scheme: scheme('Terse'),
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: false, code: 'name-taken' });
    expect(storeFiles()).toEqual(['terse.yml']);
  });

  test('an unsupported extension case still reserves the portable filename identity', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ocean.YAML'), 'user-owned unsupported file');

    const result = await saveSavedTheme({
      name: 'ocean',
      scheme: scheme('Ocean'),
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: false, code: 'name-taken' });
    expect(storeFiles()).toEqual(['ocean.YAML']);
  });

  test('never overwrites an uppercase-stem file when saving its lowercase identity', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    const uppercasePath = join(dir, 'Ocean.yaml');
    const lowercasePath = join(dir, 'ocean.yaml');
    const original = base16ToYaml(scheme('Uppercase stem'));
    writeFileSync(uppercasePath, original);
    const aliasesOnThisFilesystem = existsSync(lowercasePath);

    const result = await saveSavedTheme({
      name: 'ocean',
      scheme: scheme('Lowercase stem'),
      homedirOverride: home,
    });

    expect(readFileSync(uppercasePath, 'utf-8')).toBe(original);
    if (aliasesOnThisFilesystem) {
      expect(result).toEqual({ ok: false, code: 'name-taken' });
      expect(storeFiles()).toEqual(['Ocean.yaml']);
    } else {
      expect(result).toEqual({ ok: true, id: 'saved-ocean', filename: 'ocean.yaml' });
      expect(storeFiles()).toEqual(['Ocean.yaml', 'ocean.yaml']);
    }
  });

  test('a dangling symlink still claims its filename and is never overwritten', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dir, 'missing-target'), join(dir, 'linked.yaml'));

    const result = await saveSavedTheme({
      name: 'linked',
      scheme: scheme('Linked'),
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: false, code: 'name-taken' });
    expect(storeFiles()).toEqual(['linked.yaml']);
  });

  test('refuses an over-length explicit restore stem with a distinct code', async () => {
    // `saved-` (6) leaves 26 for the stem; 27 overflows the 32-char id budget.
    const result = await saveSavedTheme({
      name: 'a'.repeat(27),
      stem: 'a'.repeat(27),
      scheme: scheme('X'),
      homedirOverride: home,
    });
    expect(result).toEqual({ ok: false, code: 'too-long' });
    expect(storeFiles()).toEqual([]);
  });

  test('refuses an explicit restore stem outside the grammar', async () => {
    for (const stem of ['My Theme', 'sub/dir', 'UPPER']) {
      const result = await saveSavedTheme({
        name: 'Restored theme',
        stem,
        scheme: scheme('X'),
        homedirOverride: home,
      });
      expect(result).toEqual({ ok: false, code: 'invalid-chars' });
    }
    expect(storeFiles()).toEqual([]);
  });

  test('refuses an empty name', async () => {
    const result = await saveSavedTheme({ name: '', scheme: scheme('X'), homedirOverride: home });
    expect(result).toEqual({ ok: false, code: 'empty' });
    expect(storeFiles()).toEqual([]);
  });

  test('persists only the standard scheme fields — no author unless supplied', async () => {
    await saveSavedTheme({ name: 'plain', scheme: scheme('Plain'), homedirOverride: home });
    const raw = readFileSync(join(savedThemesDir(home), 'plain.yaml'), 'utf-8');
    // The file the user owns carries nothing proprietary, and no identity is
    // written for them — `author` is absent when the scheme carried none.
    expect(raw).not.toMatch(/author:/);
    expect(raw).not.toMatch(/okVersion|provenance|source:|lock/i);
  });
});

describe('updateSavedTheme', () => {
  test('replaces the existing scheme in place without creating a second file', async () => {
    await saveSavedTheme({ name: 'midnight', scheme: scheme('Midnight'), homedirOverride: home });
    const replacement = scheme('Midnight revised', 'light');
    replacement.palette.base00 = '#123456';

    const result = await updateSavedTheme({
      id: 'saved-midnight',
      scheme: replacement,
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: true, id: 'saved-midnight', filename: 'midnight.yaml' });
    expect(storeFiles()).toEqual(['midnight.yaml']);
    const [entry] = scanSavedThemes({ homedirOverride: home }).entries;
    expect(entry).toMatchObject({
      ok: true,
      id: 'saved-midnight',
      filename: 'midnight.yaml',
      scheme: { name: 'Midnight revised', variant: 'light', palette: { base00: '#123456' } },
    });
  });

  test('preserves the extension of a hand-dropped .yml theme', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terse.yml'), 'name: "Terse"\n');

    const result = await updateSavedTheme({
      id: 'saved-terse',
      scheme: scheme('Terse revised'),
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: true, id: 'saved-terse', filename: 'terse.yml' });
    expect(storeFiles()).toEqual(['terse.yml']);
  });

  test('refuses an ambiguous update when both supported extensions claim the id', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'conflict.yaml'), 'original yaml');
    writeFileSync(join(dir, 'conflict.yml'), 'original yml');

    const result = await updateSavedTheme({
      id: 'saved-conflict',
      scheme: scheme('Revised'),
      homedirOverride: home,
    });

    expect(result).toEqual({ ok: false, code: 'ambiguous-id' });
    expect(readFileSync(join(dir, 'conflict.yaml'), 'utf-8')).toBe('original yaml');
    expect(readFileSync(join(dir, 'conflict.yml'), 'utf-8')).toBe('original yml');
  });

  test('does not overwrite a case-variant extension through update', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ocean.YAML'), 'user-owned unsupported file');

    expect(
      await updateSavedTheme({
        id: 'saved-ocean',
        scheme: scheme('Ocean revised'),
        homedirOverride: home,
      }),
    ).toEqual({ ok: false, code: 'unsafe-target' });
    expect(readFileSync(join(dir, 'ocean.YAML'), 'utf-8')).toBe('user-owned unsupported file');
  });

  test('does not treat an uppercase stem as the lowercase update identity', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'Ocean.yaml');
    const original = base16ToYaml(scheme('Uppercase stem'));
    writeFileSync(path, original);

    expect(
      await updateSavedTheme({
        id: 'saved-ocean',
        scheme: scheme('Lowercase revision'),
        homedirOverride: home,
      }),
    ).toEqual({ ok: false, code: 'not-found' });
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  test('updates only the exact lowercase stem when a mixed-case pair exists', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    const uppercasePath = join(dir, 'Ocean.yaml');
    const lowercasePath = join(dir, 'ocean.yaml');
    const uppercase = base16ToYaml(scheme('Uppercase stem'));
    writeFileSync(uppercasePath, uppercase);
    if (existsSync(lowercasePath)) return;
    writeFileSync(lowercasePath, base16ToYaml(scheme('Lowercase stem')));

    expect(
      await updateSavedTheme({
        id: 'saved-ocean',
        scheme: scheme('Lowercase revision'),
        homedirOverride: home,
      }),
    ).toEqual({ ok: true, id: 'saved-ocean', filename: 'ocean.yaml' });
    expect(readFileSync(uppercasePath, 'utf-8')).toBe(uppercase);
    expect(readFileSync(lowercasePath, 'utf-8')).toContain('name: "Lowercase revision"');
  });

  test('refuses an absent or malformed id instead of turning update into create', async () => {
    expect(
      await updateSavedTheme({
        id: 'saved-absent',
        scheme: scheme('Absent'),
        homedirOverride: home,
      }),
    ).toEqual({ ok: false, code: 'not-found' });
    expect(
      await updateSavedTheme({ id: '../escape', scheme: scheme('Escape'), homedirOverride: home }),
    ).toEqual({ ok: false, code: 'invalid-id' });
    expect(storeFiles()).toEqual([]);
  });

  test('a concurrent update cannot resurrect a theme after delete', async () => {
    await saveSavedTheme({ name: 'race', scheme: scheme('Original'), homedirOverride: home });

    await Promise.all([
      updateSavedTheme({ id: 'saved-race', scheme: scheme('Revised'), homedirOverride: home }),
      deleteSavedTheme({ id: 'saved-race', homedirOverride: home }),
    ]);

    expect(storeFiles()).toEqual([]);
  });
});

describe('deleteSavedTheme', () => {
  test('removes the scheme file and leaves no copy anywhere', async () => {
    await saveSavedTheme({ name: 'gone', scheme: scheme('Gone'), homedirOverride: home });
    expect(storeFiles()).toEqual(['gone.yaml']);

    const result = await deleteSavedTheme({ id: 'saved-gone', homedirOverride: home });

    expect(result).toEqual({
      ok: true,
      existed: true,
      filename: 'gone.yaml',
      scheme: scheme('Gone'),
    });
    // Nothing left in the store, and no sibling backup / trash directory minted.
    expect(storeFiles()).toEqual([]);
    expect(readdirSync(join(home, '.ok'))).toEqual(['themes']);
  });

  test('resolves and removes a hand-dropped .yml file', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'terse.yml'), base16ToYaml(scheme('Terse')));

    const result = await deleteSavedTheme({ id: 'saved-terse', homedirOverride: home });

    expect(result).toEqual({
      ok: true,
      existed: true,
      filename: 'terse.yml',
      scheme: scheme('Terse'),
    });
    expect(storeFiles()).toEqual([]);
  });

  test('refuses an ambiguous delete when both supported extensions claim the id', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'conflict.yaml'), 'original yaml');
    writeFileSync(join(dir, 'conflict.yml'), 'original yml');

    const result = await deleteSavedTheme({ id: 'saved-conflict', homedirOverride: home });

    expect(result).toEqual({ ok: false, code: 'ambiguous-id' });
    expect(storeFiles()).toEqual(['conflict.yaml', 'conflict.yml']);
  });

  test('does not delete a case-variant extension through the canonical id', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ocean.YAML'), base16ToYaml(scheme('Ocean')));

    expect(await deleteSavedTheme({ id: 'saved-ocean', homedirOverride: home })).toEqual({
      ok: false,
      code: 'unusable-theme',
    });
    expect(storeFiles()).toEqual(['ocean.YAML']);
  });

  test('does not treat an uppercase stem as the lowercase delete identity', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'Ocean.yaml');
    const original = base16ToYaml(scheme('Uppercase stem'));
    writeFileSync(path, original);

    expect(await deleteSavedTheme({ id: 'saved-ocean', homedirOverride: home })).toEqual({
      ok: true,
      existed: false,
    });
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  test('deletes only the exact lowercase stem when a mixed-case pair exists', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    const uppercasePath = join(dir, 'Ocean.yaml');
    const lowercasePath = join(dir, 'ocean.yaml');
    const uppercase = base16ToYaml(scheme('Uppercase stem'));
    writeFileSync(uppercasePath, uppercase);
    if (existsSync(lowercasePath)) return;
    writeFileSync(lowercasePath, base16ToYaml(scheme('Lowercase stem')));

    expect(await deleteSavedTheme({ id: 'saved-ocean', homedirOverride: home })).toEqual({
      ok: true,
      existed: true,
      filename: 'ocean.yaml',
      scheme: scheme('Lowercase stem'),
    });
    expect(existsSync(lowercasePath)).toBe(false);
    expect(readFileSync(uppercasePath, 'utf-8')).toBe(uppercase);
  });

  test('deleting an id that names no file is an idempotent no-op, not an error', async () => {
    expect(existsSync(savedThemesDir(home))).toBe(false);

    const result = await deleteSavedTheme({ id: 'saved-absent', homedirOverride: home });

    expect(result).toEqual({ ok: true, existed: false });
    expect(existsSync(savedThemesDir(home))).toBe(false);
    expect(readdirSync(join(home, '.ok'))).toEqual([]);
  });

  test('a malformed id is refused with a distinct code', async () => {
    for (const id of ['dracula', 'saved-', 'saved-Bad Name', '']) {
      expect(await deleteSavedTheme({ id, homedirOverride: home })).toEqual({
        ok: false,
        code: 'invalid-id',
      });
    }
  });

  test('save then delete returns the store to empty', async () => {
    await saveSavedTheme({ name: 'ephemeral', scheme: scheme('Ephemeral'), homedirOverride: home });
    await deleteSavedTheme({ id: 'saved-ephemeral', homedirOverride: home });
    expect(scanSavedThemes({ homedirOverride: home }).entries).toEqual([]);
  });
});
