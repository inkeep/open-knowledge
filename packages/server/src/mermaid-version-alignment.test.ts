import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

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
