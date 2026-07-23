import { describe, expect, it } from 'vitest';
import {
  formatAuthRejectionWire,
  HOCUSPOCUS_AUTH_REJECTION_REASONS,
  HocuspocusAuthRejection,
  type HocuspocusAuthRejectionReason,
  isHocuspocusAuthRejectionReason,
  parseAuthRejectionWire,
} from './auth-token-schema.ts';

describe('HOCUSPOCUS_AUTH_REJECTION_REASONS', () => {
  it('contains the five wire reasons used by server-side throws', () => {
    expect([...HOCUSPOCUS_AUTH_REJECTION_REASONS].sort()).toEqual([
      'branch-mismatch',
      'doc-deleted',
      'doc-lineage-mismatch',
      'rename-redirect',
      'server-instance-mismatch',
    ]);
  });

  it('isHocuspocusAuthRejectionReason narrows known reasons', () => {
    for (const r of HOCUSPOCUS_AUTH_REJECTION_REASONS) {
      expect(isHocuspocusAuthRejectionReason(r)).toBe(true);
    }
  });

  it('isHocuspocusAuthRejectionReason rejects wire reasons that include payload', () => {
    expect(isHocuspocusAuthRejectionReason('rename-redirect:foo/bar')).toBe(false);
    expect(isHocuspocusAuthRejectionReason('doc-deleted:')).toBe(false);
  });

  it('isHocuspocusAuthRejectionReason rejects unknown strings', () => {
    expect(isHocuspocusAuthRejectionReason('')).toBe(false);
    expect(isHocuspocusAuthRejectionReason('principal-revoked')).toBe(false);
    expect(isHocuspocusAuthRejectionReason('rename-redirected')).toBe(false);
  });
});

describe('formatAuthRejectionWire', () => {
  it('omits the colon when payload is absent', () => {
    for (const r of HOCUSPOCUS_AUTH_REJECTION_REASONS) {
      expect(formatAuthRejectionWire(r)).toBe(r);
      expect(formatAuthRejectionWire(r, undefined)).toBe(r);
    }
  });

  it('treats empty-string payload as absent (no trailing colon)', () => {
    expect(formatAuthRejectionWire('rename-redirect', '')).toBe('rename-redirect');
  });

  it('joins kind and payload with a single colon', () => {
    expect(formatAuthRejectionWire('rename-redirect', 'docs/new')).toBe('rename-redirect:docs/new');
    expect(formatAuthRejectionWire('doc-deleted', 'sentinel')).toBe('doc-deleted:sentinel');
  });

  it('preserves payloads that contain colons (single-split contract)', () => {
    expect(formatAuthRejectionWire('rename-redirect', 'a:b:c')).toBe('rename-redirect:a:b:c');
  });

  it('preserves payloads that contain slashes (docName shape)', () => {
    expect(formatAuthRejectionWire('rename-redirect', 'haiku/new-haiku')).toBe(
      'rename-redirect:haiku/new-haiku',
    );
  });
});

describe('parseAuthRejectionWire', () => {
  it('returns null kind for the empty string', () => {
    expect(parseAuthRejectionWire('')).toEqual({ kind: null, payload: undefined });
  });

  it('returns null kind for unknown wire prefixes', () => {
    expect(parseAuthRejectionWire('principal-revoked')).toEqual({
      kind: null,
      payload: undefined,
    });
    expect(parseAuthRejectionWire('rename-redirected:docs/x')).toEqual({
      kind: null,
      payload: undefined,
    });
  });

  it('returns the kind with undefined payload when no colon is present', () => {
    expect(parseAuthRejectionWire('server-instance-mismatch')).toEqual({
      kind: 'server-instance-mismatch',
      payload: undefined,
    });
    expect(parseAuthRejectionWire('rename-redirect')).toEqual({
      kind: 'rename-redirect',
      payload: undefined,
    });
  });

  it('returns the kind with payload when a colon is present', () => {
    expect(parseAuthRejectionWire('rename-redirect:docs/new')).toEqual({
      kind: 'rename-redirect',
      payload: 'docs/new',
    });
  });

  it('treats trailing-colon (`<kind>:`) as absent payload', () => {
    expect(parseAuthRejectionWire('rename-redirect:')).toEqual({
      kind: 'rename-redirect',
      payload: undefined,
    });
  });

  it('splits on the FIRST colon so payloads that contain `:` round-trip', () => {
    expect(parseAuthRejectionWire('rename-redirect:a:b:c')).toEqual({
      kind: 'rename-redirect',
      payload: 'a:b:c',
    });
  });

  it('round-trip identity for every kind, with and without payload', () => {
    const payloads: (string | undefined)[] = [
      undefined,
      'simple',
      'with/slash',
      'with:colon',
      'a:b:c',
      'unicode-✓',
    ];
    for (const r of HOCUSPOCUS_AUTH_REJECTION_REASONS) {
      for (const p of payloads) {
        const wire = formatAuthRejectionWire(r, p);
        const parsed = parseAuthRejectionWire(wire);
        expect(parsed.kind).toBe(r);
        expect(parsed.payload).toBe(p === '' || p === undefined ? undefined : p);
      }
    }
  });
});

describe('HocuspocusAuthRejection', () => {
  it('exposes kind, message, and a wire-format reason equal to kind when no payload is passed', () => {
    const err = new HocuspocusAuthRejection('server-instance-mismatch', 'mismatch detected');
    expect(err.kind).toBe('server-instance-mismatch');
    expect(err.payload).toBeUndefined();
    expect(err.reason).toBe('server-instance-mismatch');
    expect(err.message).toBe('mismatch detected');
    expect(err.name).toBe('HocuspocusAuthRejection');
    expect(err).toBeInstanceOf(Error);
  });

  it('keeps existing two-arg call sites behaviorally unchanged for branch-mismatch', () => {
    const err = new HocuspocusAuthRejection('branch-mismatch', 'branch differs');
    expect(err.reason).toBe('branch-mismatch');
    expect(err.payload).toBeUndefined();
  });

  it('encodes a non-empty payload into the wire-format reason', () => {
    const err = new HocuspocusAuthRejection(
      'rename-redirect',
      'old/path renamed',
      'new/path/in/folder',
    );
    expect(err.kind).toBe('rename-redirect');
    expect(err.payload).toBe('new/path/in/folder');
    expect(err.reason).toBe('rename-redirect:new/path/in/folder');
  });

  it('treats empty-string payload as absent (matches formatAuthRejectionWire)', () => {
    const err = new HocuspocusAuthRejection('rename-redirect', 'no payload', '');
    expect(err.payload).toBeUndefined();
    expect(err.reason).toBe('rename-redirect');
  });

  it('round-trips through parseAuthRejectionWire for the rename-redirect carry-shape', () => {
    const err = new HocuspocusAuthRejection('rename-redirect', 'm', 'a:b/c');
    const parsed = parseAuthRejectionWire(err.reason);
    expect(parsed).toEqual({ kind: 'rename-redirect', payload: 'a:b/c' });
  });

  it('doc-deleted carries no payload by design', () => {
    const err = new HocuspocusAuthRejection('doc-deleted', 'gone');
    expect(err.kind).toBe('doc-deleted');
    expect(err.payload).toBeUndefined();
    expect(err.reason).toBe('doc-deleted');
  });

  it('throw/catch preserves the typed kind for downstream switches', () => {
    let caught: HocuspocusAuthRejection | undefined;
    try {
      throw new HocuspocusAuthRejection('rename-redirect', 'm', 'target');
    } catch (e) {
      caught = e as HocuspocusAuthRejection;
    }
    expect(caught).toBeInstanceOf(HocuspocusAuthRejection);
    const kind: HocuspocusAuthRejectionReason | undefined = caught?.kind;
    expect(kind).toBe('rename-redirect');
    expect(caught?.reason).toBe('rename-redirect:target');
  });
});
