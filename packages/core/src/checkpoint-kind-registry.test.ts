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
      // The kind the parser round-trips must be a registered kind.
      expect(CHECKPOINT_KINDS).toContain(parsed?.kind);
    }
    // And the registry carries no kind the parser can't produce.
    expect([...CHECKPOINT_KINDS].sort()).toEqual(Object.keys(SAMPLE_BY_KIND).sort());
  });

  it('gives every kind a complete, well-typed attribute set', () => {
    for (const kind of CHECKPOINT_KINDS) {
      const attrs = CHECKPOINT_KIND_REGISTRY[kind];
      expect(['surfaced', 'hidden']).toContain(attrs.visibility);
      expect(['metadata', 'subject-only', 'none']).toContain(attrs.bundleExposure);
      // Every GC bucket must itself be a registered kind (a real partition key).
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
    // Loss/rescue kinds may ride a consent-gated bundle (correlation only);
    // routine consolidations never do.
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
    // `lostSubstrings` is verbatim document content. A kind carrying it must
    // never be classified as safe to stage whole into a diagnostics bundle —
    // that is the difference between a correlation record and an exfiltration.
    for (const [kind, sample] of Object.entries(SAMPLE_BY_KIND)) {
      const carriesContent = 'lostSubstrings' in sample.metadata;
      const exposure = CHECKPOINT_KIND_REGISTRY[kind as CheckpointKind].bundleExposure;
      if (carriesContent) expect(exposure).toBe('subject-only');
      else expect(exposure).not.toBe('subject-only');
    }
  });
});
