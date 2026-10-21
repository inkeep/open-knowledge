import { FIXTURE_CLOSURE } from './worker-server-budget.reads.ts';

export const ROUND_READS = {
  test: './worker-server-boot-verdict.test.ts',
  reads: 'the nested Playwright config and the static closure of the stress fixture it runs',
  include: [
    'packages/app/playwright.config.ts',
    ...FIXTURE_CLOSURE,
    'packages/app/tests/stress/_helpers/boot-verdict/**',
    'packages/app/tests/stress/_helpers/setup-non-result-reporter.ts',
    'packages/app/tests/stress/_helpers/worker-server-lifetime.cjs',
  ],
};
