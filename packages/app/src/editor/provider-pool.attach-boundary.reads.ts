export const ATTACH_BOUNDARY_MODULE = 'provider-pool.ts';

export const ROUND_READS = {
  test: './provider-pool.attach-boundary.test.ts',
  reads: 'the provider pool module, which it parses for where providers attach',
  include: [`packages/app/src/editor/${ATTACH_BOUNDARY_MODULE}`],
};
