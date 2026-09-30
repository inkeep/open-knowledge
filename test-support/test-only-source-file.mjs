const SUFFIXES_BY_KIND = {
  vitest: ['.test.ts', '.test.tsx'],
  helper: ['.test-helper.ts', '.test-helper.tsx'],
  typecheck: ['.type-tests.ts', '.type-tests.tsx'],
  playwright: ['.e2e.ts'],
};

export const TEST_ONLY_SOURCE_SUFFIXES = Object.freeze(Object.values(SUFFIXES_BY_KIND).flat());

export function isTestOnlySourceFile(path, kind) {
  const suffixes = kind === undefined ? TEST_ONLY_SOURCE_SUFFIXES : SUFFIXES_BY_KIND[kind];
  return suffixes.some((suffix) => path.endsWith(suffix));
}
