import {
  ROUND_READS as AGENT_ID_READS,
  SERVER_SCAN_ROOT,
} from './agent-write-agent-id-coverage.reads.ts';

export { SERVER_SCAN_ROOT };

export const ROUND_READS = {
  ...AGENT_ID_READS,
  test: './agent-write-loss-detect-coverage.test.ts',
  reads:
    'every server source .ts and .tsx file that is not test-only, from which it lists the agent-write spine files it parses; the server and core package manifests its parser reads to resolve imports; and the test-only predicate it filters by',
  include: [...AGENT_ID_READS.include, 'packages/core/package.json'],
};
