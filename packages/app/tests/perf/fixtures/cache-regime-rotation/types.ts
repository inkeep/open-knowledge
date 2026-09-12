export type WorkloadFixtureRef = 'tight' | 'broad' | 'asymmetric';

export interface CapRegime {
  readonly maxPool: number;
  readonly maxCache: number;
  readonly activityMountLimit: number;
}

export type RotationPattern = 'hot-pocket' | 'random-eviction';

export interface DocSpec {
  readonly name: string;
  readonly sizeClass: 'small' | 'medium' | 'large';
  readonly frontmatterDensity: 'none' | 'minimal' | 'heavy';
  readonly imageCount: number;
  readonly contentBytes: number;
}

export interface WorkloadFixture {
  readonly ref: WorkloadFixtureRef;
  readonly rotationDocs: ReadonlyArray<DocSpec>;
  readonly rotationPattern: RotationPattern;
  readonly cycleDurationMs: number;
  readonly vault: ReadonlyArray<DocSpec>;
  readonly seed: number;
}

export const SIZE_ENVELOPES = {
  small: { minBytes: 500, maxBytes: 5_000 },
  medium: { minBytes: 5_000, maxBytes: 50_000 },
  large: { minBytes: 50_000, maxBytes: 500_000 },
} as const satisfies Record<DocSpec['sizeClass'], { minBytes: number; maxBytes: number }>;

export interface SizeMix {
  readonly small: number;
  readonly medium: number;
  readonly large: number;
}

export function totalDocsInMix(mix: SizeMix): number {
  return mix.small + mix.medium + mix.large;
}
