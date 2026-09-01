import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');

const DEB_TO_RPM: Record<string, string | null> = {
  'libgtk-3-0': 'gtk3',
  libnotify4: 'libnotify',
  libnss3: 'nss',
  libxss1: null,
  libxtst6: 'libXtst',
  'xdg-utils': 'xdg-utils',
  'libatspi2.0-0': 'at-spi2-core',
  libuuid1: 'libuuid',
  'libsecret-1-0': 'libsecret',
  libasound2: 'alsa-lib',
  libcups2: 'cups-libs',
  libgbm1: 'mesa-libgbm',
};

const RPM_DT_NEEDED_ADDITIONS = ['alsa-lib', 'cups-libs', 'mesa-libgbm'];

function readDepends(): { deb: string[]; rpm: string[] } {
  const config = parse(readFileSync(builderYml, 'utf8')) as {
    deb?: { depends?: unknown };
    rpm?: { depends?: unknown };
  };
  const deb = config.deb?.depends;
  const rpm = config.rpm?.depends;
  if (!Array.isArray(deb) || !Array.isArray(rpm)) {
    throw new Error(
      'electron-builder.yml must declare both deb.depends and rpm.depends as arrays — ' +
        'a `depends` key that is absent hands the target back to electron-builder’s stock ' +
        'list, which omits libsecret on rpm and all three DT_NEEDED libraries on both.',
    );
  }
  return { deb: deb as string[], rpm: rpm as string[] };
}

describe('deb.depends and rpm.depends declare the same runtime set', () => {
  test('neither list repeats an entry', () => {
    const { deb, rpm } = readDepends();
    expect(new Set(deb).size, `deb.depends has a duplicate: ${deb.join(', ')}`).toBe(deb.length);
    expect(new Set(rpm).size, `rpm.depends has a duplicate: ${rpm.join(', ')}`).toBe(rpm.length);
  });

  test('every deb dependency has a declared rpm translation', () => {
    const { deb } = readDepends();
    const untranslated = deb.filter((name) => !(name in DEB_TO_RPM));
    expect(
      untranslated,
      `deb.depends gained ${untranslated.join(', ')} with no entry in this test's DEB_TO_RPM ` +
        'table. Add the Fedora/RHEL name (or an explicit null plus the reason it does not ' +
        'translate) here AND to rpm.depends in electron-builder.yml.',
    ).toEqual([]);
  });

  test('every rpm dependency is either a translated deb entry or a known DT_NEEDED addition', () => {
    const { rpm } = readDepends();
    const known = new Set([
      ...Object.values(DEB_TO_RPM).filter((v): v is string => v !== null),
      ...RPM_DT_NEEDED_ADDITIONS,
    ]);
    const unexplained = rpm.filter((name) => !known.has(name));
    expect(
      unexplained,
      `rpm.depends carries ${unexplained.join(', ')}, which maps back to nothing. Either add ` +
        'the matching deb dependency and its DEB_TO_RPM entry, or — if it is genuinely ' +
        'rpm-only — list it in RPM_DT_NEEDED_ADDITIONS with the reason.',
    ).toEqual([]);
  });

  test('rpm.depends is exactly the translated deb set plus the DT_NEEDED additions', () => {
    const { deb, rpm } = readDepends();
    const expected = new Set([
      ...deb.map((name) => DEB_TO_RPM[name]).filter((v): v is string => v != null),
      ...RPM_DT_NEEDED_ADDITIONS,
    ]);
    expect(
      [...rpm].sort(),
      'rpm.depends and deb.depends have drifted. Both lists in electron-builder.yml describe ' +
        'one runtime set; change them together.',
    ).toEqual([...expected].sort());
  });

  test('rpm.depends does not require libXScrnSaver', () => {
    const { rpm } = readDepends();
    expect(rpm).not.toContain('libXScrnSaver');
  });

  test('rpm reuses the deb maintainer scripts', () => {
    const config = parse(readFileSync(builderYml, 'utf8')) as {
      deb?: { afterInstall?: unknown; afterRemove?: unknown };
      rpm?: { afterInstall?: unknown; afterRemove?: unknown };
    };
    expect(config.rpm?.afterInstall).toBe(config.deb?.afterInstall);
    expect(config.rpm?.afterRemove).toBe(config.deb?.afterRemove);
  });
});
