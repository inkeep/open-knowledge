import { OWNER_LIFETIME_READS } from '../meta/port-ownership-lifetime.reads.ts';

export const ROUND_READS = {
  test: './ownership-run-config.node.test.ts',
  reads: 'the nested ownership config and lifetime case, and the modules its run loads',
  include: [
    'packages/app/playwright.config.ts',
    'packages/app/tests/stress/_helpers/setup-non-result-reporter.ts',
    'packages/app/tests/stress/_helpers/setup-non-result.ts',
    'packages/app/tests/stress/_helpers/port-ownership/ownership-run.config.ts',
    'packages/app/tests/stress/_helpers/port-ownership/lifetime.ownership-case.ts',
    'packages/app/tests/stress/_helpers/port-ownership/lifetime-global-setup.ts',
    'packages/app/tests/stress/_helpers/port-ownership/lifetime-server.cjs',
    'packages/app/tests/stress/_helpers/port-ownership/occupy-selected-port.cjs',
    'packages/app/tests/stress/_helpers/port-ownership/owner-scratch-lease.cjs',
    'packages/app/tests/stress/_helpers/port-ownership/owner-scratch-janitor.cjs',
    ...OWNER_LIFETIME_READS,
  ],
};
