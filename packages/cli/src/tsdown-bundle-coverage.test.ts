import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UserConfig } from 'tsdown';
import { describe, expect, test } from 'vitest';
import cliConfig from '../tsdown.config';

const cliRoot = resolve(import.meta.dirname, '..');
const cliPkg = JSON.parse(readFileSync(resolve(cliRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
const declaredDeps = Object.keys(cliPkg.dependencies).sort();
const nativeDeps = ['@parcel/watcher', '@napi-rs/keyring', '@inkeep/open-knowledge-native-config'];
const fileTypeClosure = [
  '@borewit/text-codec',
  '@tokenizer/inflate',
  '@tokenizer/token',
  'file-type',
  'ieee754',
  'strtok3',
  'token-types',
  'uint8array-extras',
];

const serverInlinedClosure = ['sirv', 'just-bash', 'shell-quote', 'picomatch'];
function matchesBundleRule(rules: unknown, id: string): boolean {
  if (!Array.isArray(rules) || !rules.every((rule: unknown) => rule instanceof RegExp)) {
    throw new TypeError(`alwaysBundle for ${id} must be an array of RegExp rules`);
  }
  return rules.some((rule) => new RegExp(rule).test(id));
}

function buildFor(entry: string): UserConfig {
  const matches = cliConfig.filter(
    (config) =>
      typeof config.entry === 'object' &&
      config.entry !== null &&
      Object.hasOwn(config.entry, entry),
  );
  expect(matches, `Expected exactly one tsdown build for ${entry}`).toHaveLength(1);
  const config = matches[0];
  if (!config) throw new Error(`Missing build for ${entry}`);
  return config;
}

function bundleDiagnostic(dep: string, entry: string): string {
  const context = fileTypeClosure.includes(dep)
    ? "It is in the file-type closure used by the server's upload MIME sniff. "
    : serverInlinedClosure.includes(dep)
      ? 'It is inlined through server/core, not a cli package.json dependency. '
      : '';
  return (
    `Add /^${dep}(\\/|$)/ to packages/cli/tsdown.config.ts alwaysBundle for ${entry}. ` +
    context +
    `A bare import '${dep}' fails with ERR_MODULE_NOT_FOUND from app.asar.unpacked/ in the packaged app.`
  );
}

describe('tsdown alwaysBundle covers every cli runtime dep', () => {
  test('cli package.json and both build configs load', () => {
    expect(declaredDeps.length).toBeGreaterThan(0);
    expect(cliConfig).toHaveLength(2);
    expect(buildFor('cli').entry).toHaveProperty('parse-worker');
    expect(buildFor('index').entry).not.toHaveProperty('cli');
  });

  test.each([
    ...new Set([
      ...declaredDeps.filter((dep) => !nativeDeps.includes(dep)),
      ...fileTypeClosure,
      ...serverInlinedClosure,
    ]),
  ])('bundles %s in the standalone build and non-yjs library closure', (dep) => {
    for (const entry of dep === 'yjs' ? ['cli'] : ['cli', 'index']) {
      const config = buildFor(entry);
      const diagnostic = bundleDiagnostic(dep, entry);
      expect(matchesBundleRule(config.deps?.alwaysBundle, dep), diagnostic).toBe(true);
      expect(matchesBundleRule(config.deps?.alwaysBundle, `${dep}/subpath`), diagnostic).toBe(true);
      for (const unrelated of [`${dep}-unrelated`, `x-${dep}`]) {
        expect(
          matchesBundleRule(config.deps?.alwaysBundle, unrelated),
          `Anchor the ${dep} alwaysBundle rule to the package root or a subpath. ${diagnostic}`,
        ).toBe(false);
      }
    }
  });

  test.each(['cli', 'index'])('%s keeps native addons external', (entry) => {
    const config = buildFor(entry);
    expect(config.deps?.neverBundle).toEqual(expect.arrayContaining(nativeDeps));
    for (const dep of nativeDeps)
      expect(
        matchesBundleRule(config.deps?.alwaysBundle, dep),
        `${entry} must not inline native addon ${dep}`,
      ).toBe(false);
  });
});

describe('yjs split-bundling policy', () => {
  test('yjs is a declared runtime dependency (library consumers resolve the external import)', () => {
    expect(declaredDeps).toContain('yjs');
  });

  test('the library externalizes yjs without force-inlining it', () => {
    const config = buildFor('index');
    expect(
      config.deps?.neverBundle,
      'Add yjs to the library neverBundle list so consumers share one Yjs instance.',
    ).toEqual(expect.arrayContaining(['yjs']));
    expect(
      matchesBundleRule(config.deps?.alwaysBundle, 'yjs'),
      'Remove yjs from the library alwaysBundle rules so consumers share one Yjs instance.',
    ).toBe(false);
    expect(
      matchesBundleRule(config.deps?.alwaysBundle, 'yjs/subpath'),
      'Keep Yjs subpaths external in the library build to avoid a second Yjs instance.',
    ).toBe(false);
    expect(
      buildFor('cli').deps?.neverBundle,
      'The standalone CLI needs yjs inlined because its packaged output has no adjacent node_modules.',
    ).not.toEqual(expect.arrayContaining(['yjs']));
  });
});
