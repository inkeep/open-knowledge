import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('build-path wiring (R-3)', () => {
  const repoConfigs = [
    resolve(here, '..', '..', 'vite.config.ts'),
    resolve(here, '..', '..', '..', 'desktop', 'electron.vite.config.ts'),
  ];
  for (const configPath of repoConfigs) {
    test(`${configPath.split('/packages/')[1]} calls injectAppVersionEnv()`, () => {
      const src = readFileSync(configPath, 'utf-8');
      expect(src).toContain('injectAppVersionEnv()');
    });
  }
});
