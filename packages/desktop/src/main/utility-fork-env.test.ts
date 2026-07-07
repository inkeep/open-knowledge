import { describe, expect, test } from 'bun:test';
import { buildUtilityForkEnv } from './utility-fork-env.ts';

/**
 * utility fork env carries `OK_ELECTRON_PROTOCOL_HOST=1` while
 * preserving any other vars already on the parent env (PATH, HOME, etc.).
 * Proves the merge does not overwrite.
 */

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
    // If a test-harness or a parent CI run pre-set the var to something else,
    // the desktop utility should still see `'1'` — the marker is binary, not
    // value-sensitive, and accidental `0` / stale values would confuse the
    // `=== '1'` gate in preview-url.ts.
    const env = buildUtilityForkEnv({ OK_ELECTRON_PROTOCOL_HOST: '0' });
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBe('1');
  });

  test('defaults to process.env when no arg provided', () => {
    // Smoke — the no-arg overload returns *some* object with our key set.
    const env = buildUtilityForkEnv();
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBe('1');
  });

  test('sets OK_STARTUP_TRACEPARENT when provided', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const env = buildUtilityForkEnv({}, { startupTraceparent: traceparent });
    expect(env.OK_STARTUP_TRACEPARENT).toBe(traceparent);
  });

  test('omits OK_STARTUP_TRACEPARENT when not provided (no lingering value)', () => {
    const env = buildUtilityForkEnv({});
    expect(env.OK_STARTUP_TRACEPARENT).toBeUndefined();
    const env2 = buildUtilityForkEnv({}, {});
    expect(env2.OK_STARTUP_TRACEPARENT).toBeUndefined();
  });

  test('passes OTEL_EXPORTER_OTLP_ENDPOINT through when supplied', () => {
    const env = buildUtilityForkEnv({}, { otlpEndpoint: 'http://localhost:14318' });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:14318');
  });

  test('leaves an inherited OTEL_EXPORTER_OTLP_ENDPOINT intact when not overridden', () => {
    const env = buildUtilityForkEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
  });

  test('startupTraceparent + otlpEndpoint coexist with the protocol-host marker', () => {
    const env = buildUtilityForkEnv(
      { PATH: '/usr/bin' },
      { startupTraceparent: 'tp', otlpEndpoint: 'http://x:4318' },
    );
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBe('1');
    expect(env.OK_LOCK_KIND).toBe('interactive');
    expect(env.OK_STARTUP_TRACEPARENT).toBe('tp');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://x:4318');
    expect(env.PATH).toBe('/usr/bin');
  });
});
