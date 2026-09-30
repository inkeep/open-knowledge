import type { BridgeToleranceClass } from './normalize.ts';

export const PARSE_EQUIVALENCE_TOLERANCE = 'parse-equivalence' as const;

export type BridgeToleranceSignal = BridgeToleranceClass | typeof PARSE_EQUIVALENCE_TOLERANCE;
