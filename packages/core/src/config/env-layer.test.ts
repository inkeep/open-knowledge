import { describe, expect, it } from 'vitest';
import {
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
    expect(table.size).toBe(listConfigLeafPaths().length);
  });
});

describe('recognized surface pin', () => {
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
