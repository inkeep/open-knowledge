import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DESKTOP_UPDATER_CACHE_DIR_NAME } from './desktop-state.ts';

describe('desktopUpdaterCacheDir', () => {
  test('keeps the cache basename derived from the desktop package name', () => {
    const desktopPackage = JSON.parse(
      readFileSync(new URL('../../../desktop/package.json', import.meta.url), 'utf8'),
    ) as { name: string };
    const generatedName = `${desktopPackage.name.replace(/[/?<>\\:*|"]/g, '').toLowerCase()}-updater`;

    expect(DESKTOP_UPDATER_CACHE_DIR_NAME).toBe(generatedName);
  });
});
