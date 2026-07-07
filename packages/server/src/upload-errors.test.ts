/**
 * Branch coverage for `classifyUploadErrno` — the errno-to-URN mapper
 * shared by `handleUploadAsset`'s mkdir guard and busboy write pipeline.
 * `uploadStatusFor` (switch over `UploadWriteReason`) is covered by the
 * exhaustiveness meta-test, but `classifyUploadErrno` uses if/else
 * chains that the AST scanner doesn't reach.
 *
 * A regression that swaps ENOSPC and EROFS mappings would route disk-full
 * errors to 500 `storage-readonly` instead of 507 `storage-full`, causing
 * SDK consumers branching on the URN to display wrong retry guidance.
 */

import { describe, expect, test } from 'bun:test';
import { classifyUploadErrno, uploadStatusFor, uploadTitleFor } from './upload-errors.ts';

function withCode(code: string): NodeJS.ErrnoException {
  const err = new Error(`mock ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('classifyUploadErrno', () => {
  test('ENOSPC → urn:ok:error:storage-full', () => {
    expect(classifyUploadErrno(withCode('ENOSPC'))).toBe('urn:ok:error:storage-full');
  });

  test('EDQUOT → urn:ok:error:storage-full (quota exceeded behaves like full)', () => {
    expect(classifyUploadErrno(withCode('EDQUOT'))).toBe('urn:ok:error:storage-full');
  });

  test('EROFS → urn:ok:error:storage-readonly', () => {
    expect(classifyUploadErrno(withCode('EROFS'))).toBe('urn:ok:error:storage-readonly');
  });

  test('EACCES → urn:ok:error:storage-readonly', () => {
    expect(classifyUploadErrno(withCode('EACCES'))).toBe('urn:ok:error:storage-readonly');
  });

  test('EPERM → urn:ok:error:storage-readonly', () => {
    expect(classifyUploadErrno(withCode('EPERM'))).toBe('urn:ok:error:storage-readonly');
  });

  test('EIO → urn:ok:error:storage-error (generic disk I/O fallback)', () => {
    expect(classifyUploadErrno(withCode('EIO'))).toBe('urn:ok:error:storage-error');
  });

  test('unknown errno → urn:ok:error:storage-error (default branch)', () => {
    expect(classifyUploadErrno(withCode('ESOMETHINGWEIRD'))).toBe('urn:ok:error:storage-error');
  });

  test('error with no code field → urn:ok:error:storage-error', () => {
    // `NodeJS.ErrnoException.code` is optional — a plain `new Error()`
    // without `.code` set must not crash the classifier. Default branch
    // catches it.
    const err = new Error('no code at all') as NodeJS.ErrnoException;
    expect(classifyUploadErrno(err)).toBe('urn:ok:error:storage-error');
  });
});

describe('uploadStatusFor', () => {
  // The exhaustiveness meta-test verifies the switch terminates with
  // `default: assertNeverProblemType(target)` — that's a structural
  // guarantee against forgetting a variant. But it doesn't verify the
  // PER-CASE return values: a swapped mapping (e.g.,
  // `storage-full → 500` instead of `507`) would pass exhaustiveness
  // but break SDK retry guidance because consumers branch on status.
  // Pin each mapping explicitly.

  test('malformed-upload → 400', () => {
    expect(uploadStatusFor('urn:ok:error:malformed-upload')).toBe(400);
  });

  test('storage-full → 507 (RFC 4918 Insufficient Storage; retry-after-frees)', () => {
    expect(uploadStatusFor('urn:ok:error:storage-full')).toBe(507);
  });

  test('storage-readonly → 500', () => {
    expect(uploadStatusFor('urn:ok:error:storage-readonly')).toBe(500);
  });

  test('storage-error → 500', () => {
    expect(uploadStatusFor('urn:ok:error:storage-error')).toBe(500);
  });

  test('collision-exhaustion → 500', () => {
    expect(uploadStatusFor('urn:ok:error:collision-exhaustion')).toBe(500);
  });
});

describe('uploadTitleFor', () => {
  // Same per-case rationale as `uploadStatusFor`. Title strings are the
  // user-facing diagnostic surface (RFC 9457 §3.1.4); a swapped or
  // truncated mapping would surface the wrong message but pass the
  // exhaustiveness meta-test.

  test('malformed-upload title is sentence-shaped + period-terminated', () => {
    expect(uploadTitleFor('urn:ok:error:malformed-upload')).toBe('Upload payload is malformed.');
  });

  test('storage-full title', () => {
    expect(uploadTitleFor('urn:ok:error:storage-full')).toBe('Storage is full.');
  });

  test('storage-readonly title', () => {
    expect(uploadTitleFor('urn:ok:error:storage-readonly')).toBe('Storage is read-only.');
  });

  test('storage-error title', () => {
    expect(uploadTitleFor('urn:ok:error:storage-error')).toBe('Failed to write upload.');
  });

  test('collision-exhaustion title', () => {
    expect(uploadTitleFor('urn:ok:error:collision-exhaustion')).toBe(
      'Filename collision retries exhausted.',
    );
  });
});
