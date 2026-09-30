export const TEST_ONLY_SOURCE_SUFFIXES: readonly string[];

export function isTestOnlySourceFile(
  path: string,
  kind?: 'vitest' | 'helper' | 'typecheck' | 'playwright',
): boolean;
