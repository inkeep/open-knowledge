export const LLMS_FULL_WARN_BYTES = 2_500_000;
export const LLMS_FULL_MAX_BYTES = 5_000_000;

export type CorpusSizeVerdict = 'ok' | 'warn' | 'fail';

export function classifyLlmsFullSize(bytes: number): CorpusSizeVerdict {
  if (bytes > LLMS_FULL_MAX_BYTES) return 'fail';
  if (bytes > LLMS_FULL_WARN_BYTES) return 'warn';
  return 'ok';
}

export function describeLlmsFullSize(bytes: number): string {
  const mb = (limit: number) => `${(limit / 1_000_000).toFixed(1)} MB`;
  return `/llms-full.txt is ${mb(bytes)} (warn over ${mb(LLMS_FULL_WARN_BYTES)}, fail over ${mb(LLMS_FULL_MAX_BYTES)})`;
}
