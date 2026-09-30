import { normalizeBridge } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import {
  type DeriveLossObservation,
  detectApplyArmDrop,
  detectDeriveLoss,
  detectPairedIntakeLoss,
} from './bridge-loss-detector.ts';

describe('detectDeriveLoss (the twin verdict)', () => {
  it('flags a never-propagated fragment line that both twins lack', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nPending keystroke',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body',
      rebuiltBody: 'Shared body',
      restorePayload: 'Shared body\n\nPending keystroke',
    };
    expect(detectDeriveLoss(obs)).toEqual(['Pending keystroke']);
  });

  it('does NOT flag content the operation legitimately removed (an intended undo)', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Line A\n\nLine B',
      baselineBody: 'Line A\n\nLine B',
      ytextDerivedBody: 'Line A',
      rebuiltBody: 'Line A',
      restorePayload: 'Line A\n\nLine B',
    };
    expect(detectDeriveLoss(obs)).toEqual([]);
  });

  it('returns empty when the rebuild preserved the at-risk content', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nKept line',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body\n\nKept line',
      rebuiltBody: 'Shared body\n\nKept line',
      restorePayload: 'Shared body\n\nKept line',
    };
    expect(detectDeriveLoss(obs)).toEqual([]);
  });

  it('catches a loss via the independent twin when one representation is blind', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nPending keystroke',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body',
      rebuiltBody: 'Shared body\n\nPending keystroke',
      restorePayload: 'Shared body\n\nPending keystroke',
    };
    expect(detectDeriveLoss(obs)).toEqual(['Pending keystroke']);
  });
});

describe('detectApplyArmDrop (Observer-A apply verdict)', () => {
  it('flags a substantive line the applied Y.Text dropped', () => {
    const md = '# Title\n\nLine one\n\nLine two\n\nLine three';
    const applied = '# Title\n\nLine one\n\nLine three';
    expect(detectApplyArmDrop(md, normalizeBridge(md), applied, normalizeBridge(applied))).toEqual([
      'Line two',
    ]);
  });

  it('returns empty for a byte-identical apply', () => {
    const md = '# Title\n\nBody line';
    expect(detectApplyArmDrop(md, normalizeBridge(md), md, normalizeBridge(md))).toEqual([]);
  });

  it('does not flag a normalization-only difference (raw vs canonical form)', () => {
    const canonical = 'A paragraph\n\nAnother paragraph';
    const raw = 'A paragraph\n\n\n\nAnother paragraph';
    expect(normalizeBridge(raw)).toBe(normalizeBridge(canonical));
    expect(
      detectApplyArmDrop(canonical, normalizeBridge(canonical), raw, normalizeBridge(raw)),
    ).toEqual([]);
  });
});

describe('detectPairedIntakeLoss (the line-predicate floor)', () => {
  const INTRA_LINE_STOMP: DeriveLossObservation = {
    pendingBody: 'Deploy the staging server now.',
    baselineBody: 'Deploy the server now.',
    ytextDerivedBody: 'Restart the staging cluster later.',
    rebuiltBody: 'Restart the staging cluster later.',
    restorePayload: 'Deploy the staging server now.',
  };

  it('flags an intra-line stomp the substring twin filters away', () => {
    expect(detectDeriveLoss(INTRA_LINE_STOMP)).toEqual([]);
    expect(detectPairedIntakeLoss(INTRA_LINE_STOMP)).toContain('Deploy the staging server now.');
  });

  it('is a superset of the substring twin when the twin already catches the loss', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nPending keystroke',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body',
      rebuiltBody: 'Shared body',
      restorePayload: 'Shared body\n\nPending keystroke',
    };
    expect(detectDeriveLoss(obs)).toEqual(['Pending keystroke']);
    expect(detectPairedIntakeLoss(obs)).toContain('Pending keystroke');
  });

  it('does not flag an intended removal (the witness leg excludes it)', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Line A\n\nLine B',
      baselineBody: 'Line A\n\nLine B',
      ytextDerivedBody: 'Line A',
      rebuiltBody: 'Line A',
      restorePayload: 'Line A\n\nLine B',
    };
    expect(detectPairedIntakeLoss(obs)).toEqual([]);
  });
});
