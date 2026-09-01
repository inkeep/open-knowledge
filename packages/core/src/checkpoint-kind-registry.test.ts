import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_KIND_REGISTRY,
  CHECKPOINT_KINDS,
  type CheckpointKind,
  formatCheckpointBodyLine,
  isSurfacedCheckpointKind,
  parseCheckpoint,
  CHECKPOINT_SAMPLE_BY_KIND as SAMPLE_BY_KIND,
} from './shadow-repo-layout.ts';

describe('checkpoint-kind registry', () => {
  it('registers every kind the parser can produce, and no phantom kinds', () => {
    for (const sample of Object.values(SAMPLE_BY_KIND)) {
      const parsed = parseCheckpoint(formatCheckpointBodyLine(sample));
      expect(parsed?.kind).toBe(sample.kind);
      expect(CHECKPOINT_KINDS).toContain(parsed?.kind);
    }
    expect([...CHECKPOINT_KINDS].sort()).toEqual(Object.keys(SAMPLE_BY_KIND).sort());
  });

  it('gives every kind a complete, well-typed attribute set', () => {
    for (const kind of CHECKPOINT_KINDS) {
      const attrs = CHECKPOINT_KIND_REGISTRY[kind];
      expect(['surfaced', 'hidden']).toContain(attrs.visibility);
      expect(['metadata', 'subject-only', 'none']).toContain(attrs.bundleExposure);
      expect(CHECKPOINT_KINDS).toContain(attrs.gcBucket);
    }
  });

  it('surfaces loss and rescue kinds and hides routine auto-consolidation', () => {
    expect(CHECKPOINT_KIND_REGISTRY['bridge-merge-loss'].visibility).toBe('surfaced');
    expect(CHECKPOINT_KIND_REGISTRY['producer-guard-loss'].visibility).toBe('surfaced');
    expect(CHECKPOINT_KIND_REGISTRY['observer-a-duplication'].visibility).toBe('surfaced');
    expect(CHECKPOINT_KIND_REGISTRY['external-change-rescue'].visibility).toBe('surfaced');
    expect(CHECKPOINT_KIND_REGISTRY['auto-consolidation'].visibility).toBe('hidden');
  });

  it('keeps secrets out of the bundle by not exposing routine kinds', () => {
    expect(CHECKPOINT_KIND_REGISTRY['bridge-merge-loss'].bundleExposure).toBe('subject-only');
    expect(CHECKPOINT_KIND_REGISTRY['auto-consolidation'].bundleExposure).toBe('none');
  });

  describe('isSurfacedCheckpointKind', () => {
    it('treats a non-checkpoint / malformed row (null) as surfaced', () => {
      expect(isSurfacedCheckpointKind(null)).toBe(true);
      expect(isSurfacedCheckpointKind(undefined)).toBe(true);
    });

    it('hides only the kinds registered hidden', () => {
      expect(isSurfacedCheckpointKind('external-change-rescue')).toBe(true);
      expect(isSurfacedCheckpointKind('auto-consolidation')).toBe(false);
    });
  });

  it('classifies every content-bearing kind as subject-only', () => {
    for (const [kind, sample] of Object.entries(SAMPLE_BY_KIND)) {
      const carriesContent = 'lostSubstrings' in sample.metadata;
      const exposure = CHECKPOINT_KIND_REGISTRY[kind as CheckpointKind].bundleExposure;
      if (carriesContent) expect(exposure).toBe('subject-only');
      else expect(exposure).not.toBe('subject-only');
    }
  });
});
