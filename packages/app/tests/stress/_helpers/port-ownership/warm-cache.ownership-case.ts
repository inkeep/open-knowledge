import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { resolveViteSeedDir } from '../server-process.ts';

test('warm cache owns a serving endpoint before publishing its seed', async () => {
  const seedDir = resolveViteSeedDir();
  if (seedDir === undefined) throw new Error('warm cache seed pointer is not published');
  expect(existsSync(join(seedDir, 'deps', '_metadata.json'))).toBe(true);
  expect(existsSync(join(seedDir, '.seed-key'))).toBe(true);
});
