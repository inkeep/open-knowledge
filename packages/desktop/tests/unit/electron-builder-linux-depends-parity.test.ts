import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

/**
 * Drift guard: `deb.depends` and `rpm.depends` in electron-builder.yml declare
 * the SAME runtime set under two distros' naming schemes. Nothing but prose
 * held them together before this test, and the two lists fail in opposite
 * directions when they drift — a missing deb entry surfaces at `apt install`,
 * a missing rpm entry surfaces as the app exiting at exec with a bare
 * dynamic-linker message and no window, dialog, or log.
 *
 * The translation below is the contract. Adding a dependency to either list
 * without teaching the table about it fails here rather than in a user's
 * package manager.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const builderYml = resolve(desktopRoot, 'electron-builder.yml');

/**
 * Debian package name → its Fedora/RHEL counterpart, or `null` for the
 * deliberate non-translations.
 *
 * `libxss1` is the only `null` today. Its Fedora name, libXScrnSaver, is
 * EPEL-only on RHEL 10, so requiring it would make the rpm uninstallable on a
 * stock box — and it buys nothing: `objdump -p` on the packaged
 * `openknowledge` binary lists 34 DT_NEEDED entries and libXss is not among
 * them (Electron moved idle detection to DBus). The deb keeps its entry
 * because that list is electron-builder's stock set and the package is in
 * Debian/Ubuntu's default repos, where an unused dependency is a no-op.
 */
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
  // Direct DT_NEEDED entries of the packaged binary. The rpm list carries
  // these unconditionally (see RPM_DT_NEEDED_ADDITIONS); the deb list is
  // gaining them separately, and this table keeps the union stable either way.
  libasound2: 'alsa-lib',
  libcups2: 'cups-libs',
  libgbm1: 'mesa-libgbm',
};

/**
 * rpm entries that must be present whether or not the deb list has caught up.
 * The Electron binary lists all three as direct DT_NEEDED entries, so a
 * package missing any of them installs cleanly and then cannot start.
 */
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
    // Set semantics, not positional: the point is that neither list can gain
    // or lose a library without the other moving. Once the deb list picks up
    // libasound2 / libcups2 / libgbm1 they translate onto the same three names
    // the additions already contribute, so this expectation holds unchanged
    // across that landing — it does not need a revision then.
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
    // Regression pin, not a restatement of the table above: requiring it makes
    // the package uninstallable on a stock RHEL 10 (EPEL-only there), and the
    // packaged binary has no libXss DT_NEEDED entry to justify the cost. A
    // future editor "restoring parity" with libxss1 would reintroduce that.
    const { rpm } = readDepends();
    expect(rpm).not.toContain('libXScrnSaver');
  });

  test('rpm reuses the deb maintainer scripts', () => {
    // The scripts are shared on purpose (every distro-specific step in them is
    // existence-guarded). Pointing rpm at its own copy would fork the
    // /usr/bin/ok symlink behaviour and the upgrade guard silently.
    const config = parse(readFileSync(builderYml, 'utf8')) as {
      deb?: { afterInstall?: unknown; afterRemove?: unknown };
      rpm?: { afterInstall?: unknown; afterRemove?: unknown };
    };
    expect(config.rpm?.afterInstall).toBe(config.deb?.afterInstall);
    expect(config.rpm?.afterRemove).toBe(config.deb?.afterRemove);
  });
});
