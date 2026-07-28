import { describe, expect, test } from 'vitest';
import { MISSING_OK_CONFIG_MESSAGE, MissingOkConfigError } from './missing-ok-config-error.ts';

describe('MissingOkConfigError', () => {
  test('carries the canonical message verbatim for both kinds', () => {
    const a = new MissingOkConfigError('okdir', '/tmp/proj-a');
    const b = new MissingOkConfigError('config', '/tmp/proj-b');
    expect(a.message).toBe(MISSING_OK_CONFIG_MESSAGE);
    expect(b.message).toBe(MISSING_OK_CONFIG_MESSAGE);
  });

  test('discriminator + projectDir are queryable as readonly fields', () => {
    const e = new MissingOkConfigError('config', '/tmp/proj');
    expect(e.kind).toBe('config');
    expect(e.projectDir).toBe('/tmp/proj');
    expect(e.name).toBe('MissingOkConfigError');
  });

  test('forwards `cause` to the Error options bag', () => {
    const cause = new Error('underlying');
    const e = new MissingOkConfigError('okdir', '/tmp/proj', { cause });
    expect(e.cause).toBe(cause);
  });
});
