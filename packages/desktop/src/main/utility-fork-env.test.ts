import { describe, expect, test } from 'bun:test';
import { buildUtilityForkEnv } from './utility-fork-env.ts';


describe('buildUtilityForkEnv', () => {
  test('sets OK_ELECTRON_PROTOCOL_HOST=1', () => {
    const env = buildUtilityForkEnv({});
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBe('1');
  });

  test('preserves other parent-env vars via spread (no overwrite)', () => {
    const env = buildUtilityForkEnv({ PATH: '/usr/bin', HOME: '/Users/test' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/test');
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBe('1');
  });

  test('overrides a pre-existing OK_ELECTRON_PROTOCOL_HOST to "1" (canonicalize)', () => {
    const env = buildUtilityForkEnv({ OK_ELECTRON_PROTOCOL_HOST: '0' });
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBe('1');
  });

  test('defaults to process.env when no arg provided', () => {
    const env = buildUtilityForkEnv();
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBe('1');
  });
});
