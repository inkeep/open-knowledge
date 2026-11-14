import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

test('never finishes', async () => {
  writeFileSync(path.join(test.info().project.outputDir, 'hang-began'), '');
  await new Promise<never>(() => {});
});
