const OK_RULES_DIR = 'lint-plugins/ok-rules';
export const OK_RULES_TESTS_DIR = `${OK_RULES_DIR}/tests`;
export const OK_RULES_FIXTURES_DIR = `${OK_RULES_DIR}/__fixtures__`;

export const ROUND_READS = {
  test: './ok-rules-scope-partition.uncached.test.mjs',
  reads: 'the ok-rules registry, scope table, rules, fixtures and tests it partitions, and the oxlint config that loads the plugin',
  include: [`${OK_RULES_DIR}/**`, 'oxlint.config.ts'],
};
