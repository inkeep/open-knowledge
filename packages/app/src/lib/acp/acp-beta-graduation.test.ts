import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Catalog guard for the in-app agent graduating out of feature-Beta.
 *
 * The badge itself is covered at runtime (the chooser and Configure-agents DOM
 * suites render the group and assert its name), but the `In app (beta)`
 * accessible name had five separate call sites and only ONE observable that
 * reaches all of them at once: the extracted catalog. A macro that comes back
 * gets extracted, so re-adding it anywhere turns this red — and the drift gate
 * (`scripts/check-i18n-drift.sh`) is what forces the catalog to be current.
 *
 * The other half is the risk this cleanup carried: `Beta` is a SHARED msgid.
 * Plugin maturity still uses it, and the release channel owns the separate
 * `BETA` / `Beta channel` pair. Removing the ACP badge must not take any of
 * those with it, so the reference list is pinned rather than merely non-empty.
 */

const LOCALES_DIR = fileURLToPath(new URL('../../locales', import.meta.url));

const LOCALES: readonly string[] = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entryDir) => entryDir.isDirectory())
  .map((entryDir) => entryDir.name)
  .sort();

function readPo(locale: string): string {
  return readFileSync(join(LOCALES_DIR, locale, 'messages.po'), 'utf8');
}

/** The `#:` source references of one catalog entry, or null when absent.
 *  Matches the msgid line exactly so a longer id never counts as a hit. */
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
    // Plugin maturity is now the only owner of the shared feature-Beta msgid.
    expect(poEntryRefs(en, 'Beta')).toEqual(['src/components/settings/PluginBetaBadge.tsx']);
    // The auto-update channel keeps its own distinct pair.
    expect(hasMsgid(en, 'BETA')).toBe(true);
    expect(hasMsgid(en, 'Beta channel')).toBe(true);
  });
});
