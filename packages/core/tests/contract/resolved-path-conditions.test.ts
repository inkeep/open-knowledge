/**
 * Permanent fence for the stale-`dist/` resolution seam.
 *
 * The test runner resolves workspace packages through their `exports` map. Core
 * maps its own entry to `./src/index.ts` under the `development` condition and to
 * `./dist/index.mjs` otherwise. If that condition pin ever regresses — the classic
 * trigger is `NODE_ENV=production`, which flips the active condition to the
 * `default` (built) branch — the suite would silently run against stale build
 * output while staying green. This asserts the live source is what loads.
 *
 * Referential identity is the runner's own truth about which file backed the
 * import: one resolved file means one module-registry entry, so the package-name
 * import and the direct source import share their bindings. A flip to `dist/`
 * loads a second, distinct module and the identity breaks loud.
 */
import { expect, test } from 'bun:test';
import * as viaPackageName from '@inkeep/open-knowledge-core';
import * as viaSource from '../../src/index.ts';

test('the package-name import resolves to src/ (development condition), not dist/', () => {
  // Plant a positive first: if either symbol resolved to `undefined` (a rename
  // or a broken export map), the referential-identity checks below would pass
  // vacuously (`undefined === undefined`) and the fence would stop guarding.
  expect(viaSource.MarkdownManager).toBeDefined();
  expect(viaSource.sharedExtensions).toBeDefined();
  expect(viaPackageName.MarkdownManager).toBe(viaSource.MarkdownManager);
  expect(viaPackageName.sharedExtensions).toBe(viaSource.sharedExtensions);
});
