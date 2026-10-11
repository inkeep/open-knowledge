export const STEP_SLICER_SCAN_ROOTS = ['.github/scripts', 'scripts'];

export const ROUND_READS = {
  test: './step-slicer-shape.test.mjs',
  reads: 'the scripts-tier test files it scans for an unguarded slice(indexOf(...)) shape',
  include: STEP_SLICER_SCAN_ROOTS.map((root) => `${root}/*.test.mjs`),
};
