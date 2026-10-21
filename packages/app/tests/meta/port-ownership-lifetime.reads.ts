export const OWNER_LIFETIME_READS = [
  'packages/app/tests/stress/_helpers/port-ownership/owner-lifetime.cjs',
] as const;

export const ROUND_READS = {
  test: './port-ownership-lifetime.test.ts',
  reads: 'the owner-loss handler module it loads with createRequire',
  include: [...OWNER_LIFETIME_READS],
};
