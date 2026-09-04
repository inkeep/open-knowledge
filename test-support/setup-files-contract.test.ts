/**
 * Pins the real invariant: every vitest project resolves a `setupFiles` array
 * that contains the hermetic-network guard.
 *
 * This used to match config SOURCE TEXT for a derived spread, which is how the
 * guard could go missing: a project that writes its own `test: { ... }`, or its
 * own `setupFiles:` key, replaces the base array rather than extending it, and
 * every test still passes. Five rewrites of that heuristic each closed one
 * spelling and admitted the next — comment text vouching for code, a base spread
 * short-circuiting the key, an inert optional group, a name mention standing in
 * for the value, and finally `[...base.test.setupFiles].filter(...)`, which reads
 * as a derived spread and drops whatever the filter removes. A regex over source
 * text is modelling JS array semantics in a character class; it cannot converge.
 *
 * So the configs are imported and their RESOLVED arrays inspected instead. No
 * spelling can defeat that: spread, pass-through, index, `.filter`, `.concat` and
 * anything else all collapse to the array the project actually runs with.
 *
 * The earlier objection to importing them — that `packages/app/vitest.config.ts`
 * needs `@vitejs/plugin-react`, which the OK root does not depend on — does not
 * hold. Bare specifiers resolve from the importer's directory, and pnpm's
 * isolated layout puts a declared devDep at `packages/app/node_modules`, so the
 * import resolves from here. Verified by importing it from outside the package.
 *
 * Two assertions, because either alone has a blind spot. Each project's resolved
 * array is compared against `okVitestBase.test.setupFiles`, which needs no
 * maintenance when the base gains a guard but is self-referential: delete an entry
 * from the base and both sides move together. So the base is ALSO checked against
 * a literal list, which exists purely to be the fixed point the derived comparison
 * lacks. That list, `KNOWN_TEST_PROJECTS` and `KNOWN_BUILD_CONFIGS` are the three
 * things here anyone has to maintain by hand, and they are not all the same shape.
 * The two config lists are EXACT, so a config appearing or disappearing both fail;
 * a floor would have let a vanishing project pass silently, which is the direction
 * that matters. `REQUIRED_BASE_SETUP_FILES` is deliberately a subset check, since
 * the base gaining a guard should not red this file. What it does catch is a
 * project installing only SOME of the base's entries, which is the per-project
 * comparison's job: picking a single entry out of the base array fails there.
 *
 * `findConfigs` enumerates every config the repo TRACKS, so a NEW project is
 * covered the moment its config lands, with no per-project opt-in to forget.
 * Only vitest projects are imported: a build config like
 * `packages/app/vite.config.ts` mutates `process.env` and touches the filesystem at
 * module scope, so importing it to learn it has no `test` block would pay a real
 * side effect for a null result. They are enumerated in `KNOWN_BUILD_CONFIGS`
 * instead, so a new one forces a decision rather than being classified by a
 * pattern that fails open on an indirected `test` key and closed on a comment
 * containing one. The vitest configs pay their own import cost deliberately,
 * which is the price of reading resolved arrays rather than parsing text.
 * `docs/vitest.real-source.config.mts` is the only function-form one, so it is the
 * only config whose factory this file CALLS; that call runs
 * `mdx(..., { outDir: '.source-vitest' })` against this cwd rather than the docs
 * runner's, and a `git status --porcelain` after a full run measured clean. Nothing
 * pins that: `.source-vitest/` is ignored only under `docs/`, so if an upstream
 * change ever moved emission to call time the artifact would surface here as an
 * untracked OK-root directory. Nothing automated reads that: the signal is a
 * `git status` before the next commit, and a git ignore rule at OK root would
 * delete it, so none is added.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../scripts/git-clean-env.mjs';
import { okVitestBase } from './vitest.base';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Both patterns admit a dotted prefix, because the repo uses that form
// (`electron.vite.config.ts`). Start-anchoring them would hide a future
// `electron.vitest.config.ts` from the sweep entirely.
const CONFIG_FILENAME = /(?:^|\.)vite(st)?[\w.-]*\.config\.m?[jt]s$/;
const TEST_CONFIG_FILENAME = /(?:^|\.)vitest[\w.-]*\.config\.m?[jt]s$/;

// Every TRACKED config matching TEST_CONFIG_FILENAME, enumerated rather than
// counted, so a project disappearing fails as loudly as one appearing.
const KNOWN_TEST_PROJECTS = [
  'docs/vitest.config.ts',
  'docs/vitest.real-source.config.mts',
  'packages/app/vitest.config.ts',
  'packages/app/vitest.dom.config.ts',
  'packages/app/vitest.fidelity.config.ts',
  'packages/app/vitest.integration.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/cli/vitest.e2e.config.ts',
  'packages/core/vitest.config.ts',
  'packages/desktop/vitest.config.ts',
  'packages/md-conformance/md-audit/vitest.config.ts',
  'packages/md-conformance/vitest.config.ts',
  'packages/server/vitest.config.ts',
  'vitest.config.ts',
  'vitest.scripts.config.ts',
];

// Every config matching CONFIG_FILENAME that is NOT a vitest project.
const KNOWN_BUILD_CONFIGS = [
  'packages/app/vite.config.ts',
  'packages/desktop/electron.vite.config.ts',
];

// Named literally, NOT derived from the base. The per-project check compares
// against `okVitestBase.test.setupFiles`, which is self-referential on its own:
// delete an entry from the base and both sides move together, leaving the suite
// green with that guard uninstalled everywhere. This is the anchor that catches it.
const REQUIRED_BASE_SETUP_FILES = ['bun-global-shim.ts', 'no-net-connect.ts'];

const isTestConfig = (relPath: string): boolean => TEST_CONFIG_FILENAME.test(basename(relPath));

// TRACKED files, not a directory walk, and read through git rather than the
// filesystem. A PR check tests the branch MERGED with its base, so the working tree
// can lack a config the base has gained: `docs/vitest.real-source.config.mts`
// landed on main while this branch was behind it, and a disk sweep saw 14 projects
// here against CI's 15. `git ls-files` is the set the invariant is about, and it is
// the same set on a runner and in a worktree at the same commit.
//
// `ls-files` reads the INDEX, so a config staged-then-deleted from the working
// tree is still enumerated: a vitest one then fails on `import()` with a
// module-not-found naming a path that looks fine, and a build config fails
// nothing, because only vitest projects are imported. Neither is caught by the
// exact enumerations, because the index still lists the name. Filtering the sweep
// by `existsSync` would catch them there, but only by reintroducing the
// index-vs-disk skew rejected above, and the vitest half would red with a message
// telling the reader to edit `KNOWN_TEST_PROJECTS` when the fix is to restore the
// file. So it is asserted separately instead, which puts a named sentence ahead of
// the module-not-found.
//
// `gitCleanEnv()` because `execFileSync` inherits `process.env` and `cwd` does not
// override an inherited GIT_DIR, so any caller that already has one would resolve
// this `ls-files` against a different tree. The pre-push hook is NOT that caller —
// it unsets the GIT_* family before any step runs — so this is prophylaxis against
// a future caller, following `scripts/check-no-tracked-but-ignored.test.mjs`, not a
// fix for a live path.
function findConfigs(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.config.ts', '*.config.mts', '*.config.js', '*.config.mjs'],
    {
      cwd: REPO_ROOT,
      env: gitCleanEnv(),
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter((relPath) => relPath !== '' && CONFIG_FILENAME.test(basename(relPath)))
    .sort();
}

async function resolveSetupFiles(relPath: string): Promise<string[]> {
  const loaded: unknown = await import(pathToFileURL(join(REPO_ROOT, relPath)).href);
  const exported = (loaded as { default?: unknown }).default ?? loaded;
  const config =
    typeof exported === 'function' ? await exported({ command: 'serve', mode: 'test' }) : exported;
  const setupFiles = (config as { test?: { setupFiles?: unknown } }).test?.setupFiles;
  if (setupFiles === undefined) return [];
  return (Array.isArray(setupFiles) ? setupFiles : [setupFiles]).map(String);
}

const configs = findConfigs();

describe('vitest setupFiles contract', () => {
  test('every tracked config is present in the working tree', () => {
    const missing = configs.filter((relPath) => !existsSync(join(REPO_ROOT, relPath)));
    expect(
      missing,
      `git lists these configs but they are absent from the working tree: ${missing.join(', ')}. ` +
        'The sweep reads the index, so a vitest one fails below as module-not-found, and a ' +
        'build config passes every other assertion here, because the index still lists it.',
    ).toEqual([]);
  });

  test('the shared base itself still installs every required setup file', () => {
    for (const required of REQUIRED_BASE_SETUP_FILES) {
      expect(
        okVitestBase.test.setupFiles.some((entry) => basename(entry) === required),
        `okVitestBase.test.setupFiles no longer installs ${required}, so every project ` +
          'below would agree with a base that stopped installing it.',
      ).toBe(true);
    }
  });

  test('the sweep sees exactly the vitest projects the repo tracks', () => {
    expect(
      configs.filter(isTestConfig).sort(),
      'A vitest project appeared or disappeared. Confirm the new one is covered, then update ' +
        'this list; a lower bound would have let a disappearing project pass silently.',
    ).toEqual([...KNOWN_TEST_PROJECTS].sort());
  });

  test('every non-vitest config in the sweep is a known build config', () => {
    expect(configs.filter((relPath) => !isTestConfig(relPath)).sort()).toEqual(
      [...KNOWN_BUILD_CONFIGS].sort(),
    );
  });

  test.each(
    configs.filter(isTestConfig),
  )('%s resolves setupFiles containing every entry the shared base installs', async (relPath) => {
    const setupFiles = await resolveSetupFiles(relPath);
    const missing = okVitestBase.test.setupFiles.filter((entry) => !setupFiles.includes(entry));
    expect(
      missing,
      `${relPath} omits ${missing.length} shared setup file(s); it resolves ` +
        `[${setupFiles.join(', ')}]. Build it from okVitestBase.test.setupFiles ` +
        'rather than listing entries by hand.',
    ).toEqual([]);
  });
});
