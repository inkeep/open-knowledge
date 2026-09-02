import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LOCALES_DIR = fileURLToPath(new URL('../../locales', import.meta.url));

const LOCALES: readonly string[] = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entryDir) => entryDir.isDirectory())
  .map((entryDir) => entryDir.name)
  .sort();

function readPo(locale: string): string {
  return readFileSync(join(LOCALES_DIR, locale, 'messages.po'), 'utf8');
}

function poEntryRefs(po: string, id: string): string[] | null {
  for (const block of po.split('\n\n')) {
    const lines = block.split('\n');
    if (!lines.includes(`msgid "${id}"`)) continue;
    return lines.filter((line) => line.startsWith('#: ')).map((line) => line.slice(3).trim());
  }
  return null;
}

function hasMsgid(po: string, id: string): boolean {
  return poEntryRefs(po, id) !== null;
}

describe('ACP feature-Beta graduation — localization catalogs', () => {
  it('covers every shipped locale, so a single-locale leftover cannot hide', () => {
    expect(LOCALES).toContain('en');
    expect(LOCALES).toContain('pseudo');
    expect(LOCALES.length).toBeGreaterThanOrEqual(13);
  });

  it('drops the "In app (beta)" accessible name from every locale', () => {
    const offenders = LOCALES.filter((locale) => hasMsgid(readPo(locale), 'In app (beta)'));
    expect(offenders).toEqual([]);
  });

  it('drops it from the compiled catalogs the app actually loads', () => {
    const offenders = LOCALES.filter((locale) =>
      readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8').includes('In app (beta)'),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the plain "In app" group name in every locale', () => {
    const missing = LOCALES.filter((locale) => !hasMsgid(readPo(locale), 'In app'));
    expect(missing).toEqual([]);
  });

  it('leaves the unrelated Beta vocabulary intact', () => {
    const en = readPo('en');
    expect(poEntryRefs(en, 'Beta')).toEqual(['src/components/settings/PluginBetaBadge.tsx']);
    expect(hasMsgid(en, 'BETA')).toBe(true);
    expect(hasMsgid(en, 'Beta channel')).toBe(true);
  });
});
