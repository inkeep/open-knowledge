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

describe('resolveServerRuntimeConfig — remote.* alias-reads', () => {
  test('remote.port fills server.port only while it is absent', () => {
    expect(resolveServerRuntimeConfig(parse({ remote: { port: 24550 } })).port).toBe(24550);
    expect(
      resolveServerRuntimeConfig(parse({ server: { port: 8080 }, remote: { port: 24550 } })).port,
    ).toBe(8080);
  });

  test('remote.url fills server.externalUrl only while it is absent', () => {
    const legacyOnly = resolveServerRuntimeConfig(
      parse({ remote: { url: 'https://kb.example.com' } }),
    );
    expect(legacyOnly.externalUrl).toBe('https://kb.example.com');

    const both = resolveServerRuntimeConfig(
      parse({
        server: { externalUrl: 'https://new.example.com' },
        remote: { url: 'https://old.example.com' },
      }),
    );
    expect(both.externalUrl).toBe('https://new.example.com');
  });

  test('an empty-string remote.url reads as unset', () => {
    const resolved = resolveServerRuntimeConfig(parse({ remote: { url: '' } }));
    expect(resolved.externalUrl).toBeUndefined();
    expect(requiresExternalConsent(resolved)).toBe(false);
  });
});

describe('resolveServerRuntimeConfig — deprecated server.publicUrl spelling', () => {
  test('server.publicUrl fills externalUrl with full successor semantics (source stays server)', () => {
    // The old spelling is the SAME key, not the remote.* legacy flow: consumers
    // keying exposure decisions off `externalUrlSource === 'server'` (interlock,
    // issued URLs, Host/Origin admission) must see a 0.51.x config behave
    // exactly as it did before the rename.
    const resolved = resolveServerRuntimeConfig(
      parse({ server: { publicUrl: 'https://kb.example.com' } }),
    );
    expect(resolved.externalUrl).toBe('https://kb.example.com');
    expect(resolved.externalUrlSource).toBe('server');
    expect(resolved.externalUrlFromDeprecatedKey).toBe(true);
  });

  test('server.externalUrl wins over the deprecated spelling when both are set', () => {
    const resolved = resolveServerRuntimeConfig(
      parse({
        server: {
          externalUrl: 'https://new.example.com',
          publicUrl: 'https://old.example.com',
        },
      }),
    );
    expect(resolved.externalUrl).toBe('https://new.example.com');
    expect(resolved.externalUrlSource).toBe('server');
    expect(resolved.externalUrlFromDeprecatedKey).toBe(false);
  });

  test('the deprecated spelling still wins over the remote.url legacy alias', () => {
    const resolved = resolveServerRuntimeConfig(
      parse({
        server: { publicUrl: 'https://renamed.example.com' },
        remote: { url: 'https://legacy.example.com' },
      }),
    );
    expect(resolved.externalUrl).toBe('https://renamed.example.com');
    expect(resolved.externalUrlSource).toBe('server');
  });

  test('externalUrlFromDeprecatedKey is false for unset and for the remote.url alias', () => {
    expect(resolveServerRuntimeConfig(parse({})).externalUrlFromDeprecatedKey).toBe(false);
    const aliased = resolveServerRuntimeConfig(
      parse({ remote: { url: 'https://kb.example.com' } }),
    );
    expect(aliased.externalUrlFromDeprecatedKey).toBe(false);
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
    expect(explicit.externalUrlSource).toBe('server');
    expect(explicit.loopbackOnly).toBe(true);
    expect(requiresExternalConsent(explicit)).toBe(false);

    // A non-loopback bind WITH a externalUrl still trips it (the bind exposes).
    const exposedWithUrl = resolveServerRuntimeConfig(
      parse({ server: { bind: ['0.0.0.0'], externalUrl: 'https://kb.example.com' } }),
    );
    expect(requiresExternalConsent(exposedWithUrl)).toBe(true);

    // A remote.url alias-read likewise never trips it (loopback bind).
    const aliased = resolveServerRuntimeConfig(
      parse({ remote: { url: 'https://kb.example.com' } }),
    );
    expect(aliased.externalUrlSource).toBe('remote-alias');
    expect(requiresExternalConsent(aliased)).toBe(false);
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
