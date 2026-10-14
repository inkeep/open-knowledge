import { afterEach, describe, expect, test, vi } from 'vitest';
import { MissingOkConfigError, missingOkConfigMessage } from './missing-ok-config-error.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MissingOkConfigError', () => {
  test('carries the canonical message verbatim for both kinds', () => {
    const a = new MissingOkConfigError('okdir', '/tmp/proj-a');
    const b = new MissingOkConfigError('config', '/tmp/proj-b');
    expect(a.message).toBe(missingOkConfigMessage());
    expect(b.message).toBe(missingOkConfigMessage());
  });

  test('tells a Stable user to run ok init', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(new MissingOkConfigError('okdir', '/tmp/proj').message).toBe(
      'OpenKnowledge config not found at .ok/config.yml. Run ok init to scaffold OK in this directory.',
    );
  });

  test('tells a Beta user to run ok-beta init', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(new MissingOkConfigError('okdir', '/tmp/proj').message).toBe(
      'OpenKnowledge config not found at .ok/config.yml. Run ok-beta init to scaffold OK in this directory.',
    );
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
