import { describe, expect, test } from 'vitest';
import { serializeError } from './serialize-error.ts';

describe('serializeError', () => {
  test('serializes a plain Error', () => {
    const err = new Error('something broke');
    const result = serializeError(err);
    expect(result.name).toBe('Error');
    expect(result.message).toBe('something broke');
    expect(result.stack).toBeDefined();
  });

  test('scrubs macOS home paths from message', () => {
    const err = new Error("ENOENT: no such file, open '/Users/alice/projects/secret/foo.md'");
    const result = serializeError(err);
    expect(result.message).not.toContain('/Users/alice/');
    expect(result.message).toContain('~/');
  });

  test('scrubs Linux home paths from message', () => {
    const err = new Error("ENOENT: '/home/bob/work/file.txt'");
    const result = serializeError(err);
    expect(result.message).not.toContain('/home/bob/');
    expect(result.message).toContain('~/');
  });

  test('scrubs home paths from stack trace', () => {
    const err = new Error('test');
    err.stack = 'Error: test\n    at /Users/carol/dev/app/src/index.ts:10:5';
    const result = serializeError(err);
    expect(result.stack).not.toContain('/Users/carol/');
    expect(result.stack).toContain('~/');
  });

  test('handles nested cause chain (3 deep)', () => {
    const root = new Error('root');
    const mid = new Error('mid', { cause: root });
    const top = new Error('top', { cause: mid });
    const result = serializeError(top);
    expect(result.name).toBe('Error');
    expect(result.message).toBe('top');
    expect(result.cause).toBeDefined();
    const midResult = result.cause as { name: string; cause?: unknown };
    expect(midResult.name).toBe('Error');
    const rootResult = midResult.cause as { name: string };
    expect(rootResult.name).toBe('Error');
  });

  test('truncates cause chain beyond 5 levels', () => {
    let err: Error = new Error('level-0');
    for (let i = 1; i <= 6; i++) {
      err = new Error(`level-${i}`, { cause: err });
    }
    const result = serializeError(err);
    let current = result;
    let depth = 0;
    while (current.cause && depth < 10) {
      current = current.cause as typeof result;
      depth++;
    }
    expect(current.name).toBe('SerializedError.CauseDepthExceeded');
  });

  test('detects cyclic cause references', () => {
    const err = new Error('cyclic');
    (err as unknown as { cause: Error }).cause = err;
    const result = serializeError(err);
    expect(result.cause).toBeDefined();
    const causeResult = result.cause as { name: string };
    expect(causeResult.name).toBe('SerializedError.CauseCycle');
  });

  test('handles ENOENT with embedded path', () => {
    const err = Object.assign(
      new Error("ENOENT: no such file or directory, open '/Users/dave/secret/config.json'"),
      {
        code: 'ENOENT',
      },
    );
    const result = serializeError(err);
    expect(result.code).toBe('ENOENT');
    expect(result.message).toContain('~/');
    expect(result.message).not.toContain('/Users/dave/');
  });

  test('handles non-Error input (string)', () => {
    const result = serializeError('just a string with /Users/eve/path');
    expect(result.name).toBe('StringError');
    expect(result.message).toContain('~/');
    expect(result.message).not.toContain('/Users/eve/');
  });

  test('handles non-Error input (null)', () => {
    const result = serializeError(null);
    expect(result.name).toBe('UnknownError');
  });

  test('handles non-Error input (undefined)', () => {
    const result = serializeError(undefined);
    expect(result.name).toBe('UnknownError');
  });

  test('preserves error code field', () => {
    const err = Object.assign(new Error('fail'), { code: 'ERR_SOMETHING' });
    const result = serializeError(err);
    expect(result.code).toBe('ERR_SOMETHING');
  });
});
