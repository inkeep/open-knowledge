import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { VITE_E2E_SEED_DIR } from '../server-process.ts';

test('warm cache owns a serving endpoint before publishing its seed', async () => {
  expect(existsSync(join(VITE_E2E_SEED_DIR, 'deps', '_metadata.json'))).toBe(true);
  expect(existsSync(join(VITE_E2E_SEED_DIR, '.seed-key'))).toBe(true);
});
