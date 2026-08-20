import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LOOPBACK_IDLE_SHUTDOWN,
  idleShutdownToMs,
  isLoopbackBindAddress,
  isLoopbackOnlyBind,
  requiresExternalConsent,
  resolveServerRuntimeConfig,
} from './resolve-server-config.ts';
import { ConfigSchema } from './schema.ts';

function parse(partial: Record<string, unknown>) {
  return ConfigSchema.parse(partial);
}

describe('isLoopbackBindAddress', () => {
  test('accepts localhost, 127.0.0.0/8, and IPv6 ::1 (bare or bracketed)', () => {
    expect(isLoopbackBindAddress('localhost')).toBe(true);
    expect(isLoopbackBindAddress('LOCALHOST')).toBe(true);
    expect(isLoopbackBindAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackBindAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackBindAddress('::1')).toBe(true);
    expect(isLoopbackBindAddress('[::1]')).toBe(true);
  });

  test('rejects all-interfaces and external addresses', () => {
    expect(isLoopbackBindAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackBindAddress('::')).toBe(false);
    expect(isLoopbackBindAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackBindAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackBindAddress('example.com')).toBe(false);
  });

  test('rejects foreign hostnames that merely contain a loopback name', () => {
    expect(isLoopbackBindAddress('localhost.evil.com')).toBe(false);
    expect(isLoopbackBindAddress('127.0.0.1.evil.com')).toBe(false);
  });

  test('rejects 127.x addresses with out-of-range octets (fail-closed toward requiring consent)', () => {
    expect(isLoopbackBindAddress('127.999.0.1')).toBe(false);
    expect(isLoopbackBindAddress('127.0.0.256')).toBe(false);
    // Boundary: 255 is valid, 256 is not.
    expect(isLoopbackBindAddress('127.255.255.255')).toBe(true);
  });
});

describe('isLoopbackOnlyBind', () => {
  test('true only when every address is loopback', () => {
    expect(isLoopbackOnlyBind(['127.0.0.1'])).toBe(true);
    expect(isLoopbackOnlyBind(['127.0.0.1', '::1'])).toBe(true);
    expect(isLoopbackOnlyBind(['127.0.0.1', '0.0.0.0'])).toBe(false);
  });
});

describe('resolveServerRuntimeConfig — defaults', () => {
  test('empty config resolves to loopback-only with derived local defaults', () => {
    const resolved = resolveServerRuntimeConfig(parse({}));
    expect(resolved.bind).toEqual(['127.0.0.1']);
    expect(resolved.loopbackOnly).toBe(true);
    expect(resolved.port).toBeUndefined();
    expect(resolved.externalUrl).toBeUndefined();
    expect(resolved.allowExternal).toBe(false);
    // Loopback-only derivations: a laptop start pops the UI and idles out.
    expect(resolved.openBrowser).toBe(true);
    expect(resolved.idleShutdown).toBe(DEFAULT_LOOPBACK_IDLE_SHUTDOWN);
  });

  test('undefined config resolves like an empty one', () => {
    const resolved = resolveServerRuntimeConfig(undefined);
    expect(resolved.bind).toEqual(['127.0.0.1']);
    expect(resolved.openBrowser).toBe(true);
    expect(resolved.idleShutdown).toBe(DEFAULT_LOOPBACK_IDLE_SHUTDOWN);
  });

  test('a non-loopback bind derives headless defaults (no browser, no idle shutdown)', () => {
    const resolved = resolveServerRuntimeConfig(parse({ server: { bind: ['0.0.0.0'] } }));
    expect(resolved.loopbackOnly).toBe(false);
    expect(resolved.openBrowser).toBe(false);
    expect(resolved.idleShutdown).toBe('off');
  });

  test('explicit openBrowser / idleShutdown win over the derivation in both directions', () => {
    const headlessLaptop = resolveServerRuntimeConfig(
      parse({ server: { openBrowser: false, idleShutdown: 'off' } }),
    );
    expect(headlessLaptop.openBrowser).toBe(false);
    expect(headlessLaptop.idleShutdown).toBe('off');

    const eagerContainer = resolveServerRuntimeConfig(
      parse({ server: { bind: ['0.0.0.0'], openBrowser: true, idleShutdown: '2h' } }),
    );
    expect(eagerContainer.openBrowser).toBe(true);
    expect(eagerContainer.idleShutdown).toBe('2h');
  });
});

describe('resolveServerRuntimeConfig — externalUrl', () => {
  test('server.externalUrl sets externalUrl', () => {
    const resolved = resolveServerRuntimeConfig(
      parse({ server: { externalUrl: 'https://kb.example.com' } }),
    );
    expect(resolved.externalUrl).toBe('https://kb.example.com');
  });

  test('an unset externalUrl stays undefined', () => {
    const resolved = resolveServerRuntimeConfig(parse({}));
    expect(resolved.externalUrl).toBeUndefined();
  });
});

describe('requiresExternalConsent', () => {
  test('false for the loopback-only default', () => {
    expect(requiresExternalConsent(resolveServerRuntimeConfig(parse({})))).toBe(false);
  });

  test('true for a non-loopback bind', () => {
    const resolved = resolveServerRuntimeConfig(parse({ server: { bind: ['0.0.0.0'] } }));
    expect(requiresExternalConsent(resolved)).toBe(true);
  });

  test('a committed externalUrl under a loopback bind is inert — does NOT trip the interlock', () => {
    // externalUrl is project-scoped (committed, shared): a team deploying to a
    // VPS commits it. Under a loopback bind it is inert metadata — nothing
    // external reaches the server directly, and a same-box proxy's forwarded
    // requests are still gated at request time. Tripping the boot interlock on
    // externalUrl alone would lock out every teammate who clones the repo and
    // opens it locally (loopback), especially in desktop where config-derived
    // consent is forced off. Only a non-loopback bind is a boot-time question.
    const explicit = resolveServerRuntimeConfig(
      parse({ server: { externalUrl: 'https://kb.example.com' } }),
    );
    expect(explicit.loopbackOnly).toBe(true);
    expect(requiresExternalConsent(explicit)).toBe(false);

    // A non-loopback bind WITH a externalUrl still trips it (the bind exposes).
    const exposedWithUrl = resolveServerRuntimeConfig(
      parse({ server: { bind: ['0.0.0.0'], externalUrl: 'https://kb.example.com' } }),
    );
    expect(requiresExternalConsent(exposedWithUrl)).toBe(true);
  });

  test('consent state itself does not change whether consent is required', () => {
    const resolved = resolveServerRuntimeConfig(
      parse({ server: { bind: ['0.0.0.0'], allowExternal: true } }),
    );
    expect(requiresExternalConsent(resolved)).toBe(true);
    expect(resolved.allowExternal).toBe(true);
  });
});

describe('idleShutdownToMs', () => {
  test("'off' is null (never shut down)", () => {
    expect(idleShutdownToMs('off')).toBeNull();
  });

  test('converts s / m / h durations', () => {
    expect(idleShutdownToMs('90s')).toBe(90_000);
    expect(idleShutdownToMs('30m')).toBe(1_800_000);
    expect(idleShutdownToMs('2h')).toBe(7_200_000);
  });

  test('throws on strings the schema would have rejected', () => {
    expect(() => idleShutdownToMs('30')).toThrow();
    expect(() => idleShutdownToMs('0m')).toThrow();
    expect(() => idleShutdownToMs('1d')).toThrow();
    expect(() => idleShutdownToMs('')).toThrow();
  });
});
