import { describe, expect, it } from 'vitest';
import { isConcurrentOverwriteRefusal } from '../stress/_helpers/fixtures.ts';

function problemError(status: number, type?: string): Error {
  const err: Error & { status?: number; type?: string } = new Error(
    `agent-write-md failed: ${status}`,
  );
  err.status = status;
  if (type !== undefined) err.type = type;
  return err;
}

describe('isConcurrentOverwriteRefusal', () => {
  it('retries a 409 carrying the concurrent-overwrite-refused problem type', () => {
    expect(
      isConcurrentOverwriteRefusal(problemError(409, 'urn:ok:error:concurrent-overwrite-refused')),
    ).toBe(true);
  });

  it('refuses to retry a 409 carrying the doc-in-conflict problem type', () => {
    expect(isConcurrentOverwriteRefusal(problemError(409, 'urn:ok:error:doc-in-conflict'))).toBe(
      false,
    );
  });

  it('refuses to retry a 409 whose problem type never reached the error', () => {
    expect(isConcurrentOverwriteRefusal(problemError(409))).toBe(false);
  });

  it('refuses to retry a non-409 carrying the refusal problem type', () => {
    expect(
      isConcurrentOverwriteRefusal(problemError(500, 'urn:ok:error:concurrent-overwrite-refused')),
    ).toBe(false);
  });

  it('refuses to retry a plain object that is not an Error', () => {
    expect(
      isConcurrentOverwriteRefusal({
        status: 409,
        type: 'urn:ok:error:concurrent-overwrite-refused',
      }),
    ).toBe(false);
  });
});
