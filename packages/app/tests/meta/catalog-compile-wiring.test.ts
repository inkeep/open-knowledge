import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG_COMPILE = /compile-i18n-catalogs\.ts|i18n-compile-unless-skipped/;
const IN_PLACE_COMPILE = /\blingui compile\b/;
const SCRIPT_REFERENCE = /\b(pnpm|npm|yarn|turbo)(?=\s|$)(?: run)?(?: ([^\s;&|]+))?[^;&|]*/g;

const scripts = (
  JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

function scriptsRunBy(entry: string): { reached: Map<string, string>; unfollowed: string[] } {
  const reached = new Map<string, string>();
  const unfollowed: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const name = pending.shift() as string;
    for (const candidate of [`pre${name}`, name, `post${name}`]) {
      const command = scripts[candidate];
      if (command === undefined || reached.has(candidate)) continue;
      reached.set(candidate, command);
      for (const [call, runner, referenced] of command.matchAll(SCRIPT_REFERENCE)) {
        if (runner !== 'turbo' && referenced !== undefined && Object.hasOwn(scripts, referenced)) {
          pending.push(referenced);
        } else {
          unfollowed.push(`"${candidate}": ${call.trim()}`);
        }
      }
    }
  }
  return { reached, unfollowed };
}

function catalogCompilesRunBy(entry: string): string[] {
  return [...scriptsRunBy(entry).reached]
    .filter(([, command]) => CATALOG_COMPILE.test(command))
    .map(([name, command]) => `"${name}": ${command}`);
}

describe('every script that reads the compiled catalogs compiles them first', () => {
  test.each(['i18n', 'dev', 'build', 'typecheck', 'check'])(
    'the %s script reaches the catalog compile',
    (entry) => {
      expect(
        catalogCompilesRunBy(entry),
        `packages/app/package.json "${entry}" reaches no command matching ${CATALOG_COMPILE}. src/locales/*/messages.json is generated and ignored by git, so a fresh checkout has none, and this script bundles, typechecks or serves them. Run pnpm run i18n:compile first, which runs scripts/compile-i18n-catalogs.ts on the pinned Node.`,
      ).not.toEqual([]);
    },
  );

  test.each([
    ['dev', 'turbo run'],
    ['check', 'pnpm -w run'],
  ])('the %s script reaches a `%s` call this test cannot follow', (entry, form) => {
    const reported = scriptsRunBy(entry).unfollowed.filter((call) => call.includes(form));
    expect(
      reported,
      `packages/app/package.json "${entry}" reaches no \`${form}\` call that this test reports as one it cannot follow. Either the walk stopped reporting calls of that form, so the build check below can pass while the build makes one, or the manifest no longer makes that call: then point this control at another call of that form.`,
    ).not.toEqual([]);
  });

  test('the build calls only scripts this test can follow', () => {
    expect(scripts.build, 'packages/app/package.json has no "build" script').toBeDefined();
    const { unfollowed } = scriptsRunBy('build');
    expect(
      unfollowed,
      `packages/app/package.json "build" reaches a call this test cannot follow to a script in this manifest (${unfollowed.join('; ')}), so it cannot tell whether the build compiles the i18n catalogs. Call the script as \`pnpm run <name>\`, or extend this test to follow the new form.`,
    ).toEqual([]);
  });

  test('no script runs lingui compile in place', () => {
    const inPlace = Object.entries(scripts)
      .filter(([, command]) => IN_PLACE_COMPILE.test(command))
      .map(([name, command]) => `"${name}": ${command}`);
    expect(
      inPlace,
      `packages/app/package.json runs lingui compile directly (${inPlace.join('; ')}). lingui compile writes src/locales/*/messages.json in place, so another task in the same run can read a catalog mid-write. Call scripts/compile-i18n-catalogs.ts, as pnpm run i18n:compile does, which compiles into a scratch directory and renames only the catalogs that changed into place.`,
    ).toEqual([]);
  });
});
