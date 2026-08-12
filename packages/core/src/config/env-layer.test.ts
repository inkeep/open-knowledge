import { describe, expect, it } from 'vitest';
import {
  DEPRECATED_ENV_ALIASES,
  EnvVarError,
  listConfigLeafPaths,
  mechanicalEnvName,
  mechanicalEnvNameTable,
  RECOGNIZED_ENV_VARS,
  resolveEnvConfigLayer,
} from './env-layer.ts';

describe('mechanical naming rule', () => {
  it('server-section leaves map to bare OK_<LEAF>', () => {
    expect(mechanicalEnvName(['server', 'bind'])).toBe('OK_BIND');
    expect(mechanicalEnvName(['server', 'externalUrl'])).toBe('OK_EXTERNAL_URL');
    expect(mechanicalEnvName(['server', 'allowExternal'])).toBe('OK_ALLOW_EXTERNAL');
    expect(mechanicalEnvName(['server', 'idleShutdown'])).toBe('OK_IDLE_SHUTDOWN');
    expect(mechanicalEnvName(['server', 'openBrowser'])).toBe('OK_OPEN_BROWSER');
  });

  it('other sections map to OK_<SECTION>_<LEAF>', () => {
    expect(mechanicalEnvName(['content', 'dir'])).toBe('OK_CONTENT_DIR');
    expect(mechanicalEnvName(['autoSync', 'mode'])).toBe('OK_AUTO_SYNC_MODE');
  });

  it('the full table covers every config leaf', () => {
    const table = mechanicalEnvNameTable();
    expect(table.get('OK_CONTENT_DIR')).toEqual(['content', 'dir']);
    expect(table.get('OK_AUTO_SYNC_MODE')).toEqual(['autoSync', 'mode']);
    // Every enumerated leaf appears exactly once (no name collisions).
    expect(table.size).toBe(listConfigLeafPaths().length);
  });
});

describe('recognized surface pin', () => {
  // Name-lock guard: env names lock at the release that first ships them.
  // Widening this set is a deliberate ratification, never a drive-by — a
  // failure here means the shipped env surface changed.
  it('is exactly the ratified Table 2 set', () => {
    expect(new Map(RECOGNIZED_ENV_VARS)).toEqual(
      new Map([
        ['PORT', ['server', 'port']],
        ['OK_BIND', ['server', 'bind']],
        ['OK_EXTERNAL_URL', ['server', 'externalUrl']],
        ['OK_ALLOW_EXTERNAL', ['server', 'allowExternal']],
        ['OK_OPEN_BROWSER', ['server', 'openBrowser']],
        ['OK_IDLE_SHUTDOWN', ['server', 'idleShutdown']],
      ]),
    );
  });

  // Same name-lock reasoning for the deprecated set: entries leave only when
  // their removal window closes, and each must target the SUCCESSOR path so
  // the env layer keeps its precedence over the file layers.
  it('deprecated aliases are exactly OK_PUBLIC_URL → server.externalUrl', () => {
    expect(new Map(DEPRECATED_ENV_ALIASES)).toEqual(
      new Map([
        ['OK_PUBLIC_URL', { successor: 'OK_EXTERNAL_URL', path: ['server', 'externalUrl'] }],
      ]),
    );
  });
});

describe('resolveEnvConfigLayer', () => {
  it('parses the full ratified surface into a deep-partial layer', () => {
    const { layer, overrides, diagnostics } = resolveEnvConfigLayer({
      PORT: '8080',
      OK_BIND: '127.0.0.1 100.64.0.7',
      OK_EXTERNAL_URL: 'https://kb.example.com',
      OK_ALLOW_EXTERNAL: '1',
      OK_OPEN_BROWSER: 'false',
      OK_IDLE_SHUTDOWN: 'off',
    });
    expect(layer).toEqual({
      server: {
        port: 8080,
        bind: ['127.0.0.1', '100.64.0.7'],
        externalUrl: 'https://kb.example.com',
        allowExternal: true,
        openBrowser: false,
        idleShutdown: 'off',
      },
    });
    expect(overrides).toHaveLength(6);
    expect(diagnostics).toEqual([]);
  });

  it('ignores unset and empty values (PORT="" platform quirk)', () => {
    const { overrides } = resolveEnvConfigLayer({ PORT: '', OK_BIND: '   ' });
    expect(overrides).toEqual([]);
  });

  it('booleans accept exactly 1/0/true/false and are never presence-checked', () => {
    expect(resolveEnvConfigLayer({ OK_ALLOW_EXTERNAL: 'true' }).layer).toEqual({
      server: { allowExternal: true },
    });
    expect(resolveEnvConfigLayer({ OK_ALLOW_EXTERNAL: '0' }).layer).toEqual({
      server: { allowExternal: false },
    });
    expect(() => resolveEnvConfigLayer({ OK_ALLOW_EXTERNAL: 'yes' })).toThrow(EnvVarError);
    expect(() => resolveEnvConfigLayer({ OK_OPEN_BROWSER: 'on' })).toThrow(/OK_OPEN_BROWSER/);
  });

  it('rejects malformed values with the env var named', () => {
    expect(() => resolveEnvConfigLayer({ PORT: 'dynamic' })).toThrow(/^PORT:/);
    expect(() => resolveEnvConfigLayer({ PORT: '70000' })).toThrow(EnvVarError);
    expect(() => resolveEnvConfigLayer({ OK_EXTERNAL_URL: 'not a url' })).toThrow(
      /OK_EXTERNAL_URL/,
    );
    expect(() => resolveEnvConfigLayer({ OK_EXTERNAL_URL: 'ftp://kb.example.com' })).toThrow(
      EnvVarError,
    );
    expect(() => resolveEnvConfigLayer({ OK_IDLE_SHUTDOWN: '30x' })).toThrow(/OK_IDLE_SHUTDOWN/);
  });

  it('accepts http externalUrl (tailnet/LAN use) and duration idleShutdown', () => {
    const { layer } = resolveEnvConfigLayer({
      OK_EXTERNAL_URL: 'http://laptop.tail:55222',
      OK_IDLE_SHUTDOWN: '45m',
    });
    expect(layer).toEqual({
      server: { externalUrl: 'http://laptop.tail:55222', idleShutdown: '45m' },
    });
  });

  it('warns on OK_PORT (the ratified spelling is unprefixed PORT)', () => {
    const { diagnostics, overrides } = resolveEnvConfigLayer({ OK_PORT: '8080' });
    expect(overrides).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('unprefixed PORT');
  });

  it('warns when an unknown var mechanically maps to a non-env-configurable leaf', () => {
    const { diagnostics } = resolveEnvConfigLayer({ OK_AUTO_SYNC_MODE: 'commit' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('autoSync.mode');
    expect(diagnostics[0]?.message).toContain('not env-configurable');
  });

  it('warns did-you-mean on a near-miss of a recognized name', () => {
    const { diagnostics } = resolveEnvConfigLayer({ OK_BINDD: '0.0.0.0' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('OK_BIND');
  });

  it('a near-miss of a deprecated alias still hints, steering to the successor', () => {
    // OK_PUBLIC_URL left the recognized set for the deprecated table; its
    // typos are nowhere near OK_EXTERNAL_URL by edit distance, so they must
    // keep matching the old name — silently dropping the hint would regress
    // the pre-rename diagnostic.
    const { diagnostics, overrides } = resolveEnvConfigLayer({
      OK_PUBLI_URL: 'https://kb.example.com',
    });
    expect(overrides).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('OK_PUBLIC_URL');
    expect(diagnostics[0]?.message).toContain('OK_EXTERNAL_URL');
    expect(diagnostics[0]?.message).toContain('deprecated');
  });

  it('deprecated OK_PUBLIC_URL still resolves — to the successor path — and warns', () => {
    const { layer, overrides, diagnostics } = resolveEnvConfigLayer({
      OK_PUBLIC_URL: 'https://kb.example.com',
    });
    // Successor path, NOT ['server', 'publicUrl'] — writing the deprecated
    // config leaf would let a config-file server.externalUrl outrank the env
    // var, breaking env > file precedence for 0.51.x deployments.
    expect(layer).toEqual({ server: { externalUrl: 'https://kb.example.com' } });
    expect(overrides).toEqual([
      {
        path: ['server', 'externalUrl'],
        envVar: 'OK_PUBLIC_URL',
        value: 'https://kb.example.com',
      },
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('deprecated');
    expect(diagnostics[0]?.message).toContain('OK_EXTERNAL_URL');
  });

  it('OK_EXTERNAL_URL wins when both spellings are set, with an ignored-var warning', () => {
    const { layer, overrides, diagnostics } = resolveEnvConfigLayer({
      OK_EXTERNAL_URL: 'https://new.example.com',
      OK_PUBLIC_URL: 'https://old.example.com',
    });
    expect(layer).toEqual({ server: { externalUrl: 'https://new.example.com' } });
    expect(overrides).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.envVar).toBe('OK_PUBLIC_URL');
    expect(diagnostics[0]?.message).toContain('ignored');
  });

  it('deprecated OK_PUBLIC_URL keeps the fail-loud validation of the recognized set', () => {
    expect(() => resolveEnvConfigLayer({ OK_PUBLIC_URL: 'not a url' })).toThrow(/OK_PUBLIC_URL/);
    expect(() => resolveEnvConfigLayer({ OK_PUBLIC_URL: 'ftp://kb.example.com' })).toThrow(
      EnvVarError,
    );
    // Empty/whitespace reads as unset — and unset never warns.
    const { overrides, diagnostics } = resolveEnvConfigLayer({ OK_PUBLIC_URL: '   ' });
    expect(overrides).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('stays silent on legitimate operational OK_* vars and non-OK vars', () => {
    const { diagnostics, overrides } = resolveEnvConfigLayer({
      OK_LOCK_KIND: 'mcp-spawned',
      OK_RECLAIM_DISABLE: '1',
      OK_DESTROY_STEP_TIMEOUT_MS: '9000',
      HOME: '/home/u',
      HOST: '0.0.0.0',
    });
    expect(overrides).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
