export const ROUND_READS = {
  test: './worker-server-budget.test.ts',
  reads:
    'the worker-server fixture its runtime checks load, with everything it imports, the app package.json and a timeline fixture',
  roots: ['packages/app/tests/stress/_helpers/fixtures.ts'],
  include: [
    'packages/app/package.json',
    'packages/app/tests/meta/fixtures/first-load-crossing-timeline.json',
  ],
};
