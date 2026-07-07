/**
 * The validator must agree with the renderer: `packages/server` (validation)
 * and `packages/app` (browser rendering) must declare the IDENTICAL `mermaid`
 * range so the single workspace lockfile resolves one shared version. A
 * drifted range silently produces false-pass/false-fail warnings — bump both
 * together.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('server and app declare the identical mermaid range', () => {
  const serverPkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const appPkg = JSON.parse(
    readFileSync(join(import.meta.dir, '../../app/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };

  const serverRange = serverPkg.dependencies?.mermaid;
  const appRange = appPkg.dependencies?.mermaid;
  expect(serverRange).toBeDefined();
  expect(appRange).toBeDefined();
  expect(serverRange).toBe(appRange as string);
});
