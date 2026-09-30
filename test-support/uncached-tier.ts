export const EXTENSIONS = ['ts', 'tsx', 'mjs'];

export const UNCACHED_TIER_CONFIG = 'vitest.uncached.config.ts';

export const UNCACHED_TEST_GLOBS = EXTENSIONS.map((extension) => `**/*.uncached.test.${extension}`);

export function isUncachedTestFile(path: string): boolean {
  return EXTENSIONS.some((extension) => path.endsWith(`.uncached.test.${extension}`));
}
