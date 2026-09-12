import { homedir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { buildShellEnv } from '../utility/pty-host.ts';
import {
  composeOkChildEnv,
  okChildEnvOptions,
  okChildHome,
  okManagedBinDirs,
  okPackagedCliBinDir,
} from './ok-child-env.ts';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const WIN_CLI_BIN = 'C:\\Program Files\\Open Knowledge\\resources\\cli\\bin';

describe('okPackagedCliBinDir', () => {
  test('is the packaged cli bin under resourcesPath on win32', () => {
    expect(okPackagedCliBinDir('win32', 'C:\\Program Files\\Open Knowledge\\resources')).toBe(
      WIN_CLI_BIN,
    );
  });

  test('is undefined off win32', () => {
    expect(
      okPackagedCliBinDir('darwin', '/Applications/OK.app/Contents/Resources'),
    ).toBeUndefined();
    expect(okPackagedCliBinDir('linux', '/opt/ok/resources')).toBeUndefined();
  });

  test('is undefined when resourcesPath is absent, so it is safe outside Electron', () => {
    expect(okPackagedCliBinDir('win32', undefined)).toBeUndefined();
    expect(okPackagedCliBinDir('win32', '')).toBeUndefined();
  });
});

describe('okManagedBinDirs', () => {
  test.each([
    ['darwin' as const, { home: '/Users/alice' }, ['/Users/alice/.ok/bin']],
    ['linux' as const, { home: '/home/alice' }, ['/home/alice/.ok/bin']],
    ['darwin' as const, {}, []],
    ['win32' as const, { cliBinDir: WIN_CLI_BIN }, [WIN_CLI_BIN]],
    ['win32' as const, { home: 'C:\\Users\\alice' }, []],
  ])('%s %o', (platform, options, expected) => {
    expect(okManagedBinDirs({ platform, ...options })).toEqual(expected);
  });
});

describe('composeOkChildEnv PATH grant', () => {
  test('prepends the OK-managed bin dir on POSIX', () => {
    const env = composeOkChildEnv(
      { PATH: '/usr/bin:/bin' },
      { platform: 'darwin', home: '/Users/alice' },
    );
    expect(env.PATH).toBe('/Users/alice/.ok/bin:/usr/bin:/bin');
  });

  test('leaves an already-present entry where it is rather than moving it to the front', () => {
    const env = composeOkChildEnv(
      { PATH: '/opt/x:/Users/alice/.ok/bin:/usr/bin' },
      { platform: 'darwin', home: '/Users/alice' },
    );
    expect(env.PATH).toBe('/opt/x:/Users/alice/.ok/bin:/usr/bin');
  });

  test('leaves PATH untouched when there is no home to resolve against', () => {
    const env = composeOkChildEnv({ PATH: '/usr/bin' }, { platform: 'linux' });
    expect(env.PATH).toBe('/usr/bin');
  });

  test('writes through the inherited PATH key casing on win32 and never adds the POSIX dir', () => {
    const env = composeOkChildEnv(
      { Path: 'C:\\Windows\\System32;C:\\Tools', HOME: 'C:\\Users\\alice' },
      { platform: 'win32', home: 'C:\\Users\\alice', cliBinDir: WIN_CLI_BIN },
    );
    expect(env.Path).toBe(`${WIN_CLI_BIN};C:\\Windows\\System32;C:\\Tools`);
    expect(env.PATH).toBeUndefined();
    expect(env.Path).not.toContain('.ok');
  });

  test('dedupes case-insensitively on win32', () => {
    const env = composeOkChildEnv(
      { Path: `C:\\Windows;${WIN_CLI_BIN.toUpperCase()}` },
      { platform: 'win32', cliBinDir: WIN_CLI_BIN },
    );
    expect(env.Path).toBe(`C:\\Windows;${WIN_CLI_BIN.toUpperCase()}`);
  });

  test('seeds PATH when the parent carries none', () => {
    const env = composeOkChildEnv({}, { platform: 'darwin', home: '/Users/alice' });
    expect(env.PATH).toBe('/Users/alice/.ok/bin');
  });
});

describe('composeOkChildEnv', () => {
  test('strips OK and Electron markers, drops undefined, and grants the OK-managed bin dir', () => {
    const env = composeOkChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/x',
        OK_ELECTRON_PROTOCOL_HOST: '1',
        OK_LOCK_KIND: 'interactive',
        ELECTRON_RUN_AS_NODE: '1',
        OK_DESKTOP_TERMINAL: '1',
        OK_HOSTED_AGENT: '1',
        GDK_PIXBUF_MODULEDIR: '/app/lib/gdk-pixbuf',
        GDK_PIXBUF_MODULE_FILE: '/app/lib/loaders.cache',
        ELECTRON_TRASH: 'gio',
        GDK_THEME: 'Adwaita',
        MAYBE: undefined,
      },
      { platform: 'darwin', home: '/Users/x' },
    );
    expect(env).toEqual({
      PATH: '/Users/x/.ok/bin:/usr/bin',
      HOME: '/Users/x',
      ELECTRON_TRASH: 'gio',
      GDK_THEME: 'Adwaita',
    });
  });

  test('does not mark the child as the OK Desktop terminal', () => {
    const env = composeOkChildEnv(
      { PATH: '/usr/bin', HOME: '/Users/x' },
      { platform: 'darwin', home: '/Users/x' },
    );
    expect(Object.keys(env).some((key) => key.startsWith('OK_DESKTOP_TERMINAL'))).toBe(false);
  });

  test('drops an inherited hosted-agent marker instead of passing it to the child', () => {
    const env = composeOkChildEnv(
      { PATH: '/usr/bin', HOME: '/Users/x', OK_DESKTOP_TERMINAL: '1', OK_HOSTED_AGENT: '1' },
      { platform: 'darwin', home: '/Users/x' },
    );
    expect(env.OK_DESKTOP_TERMINAL).toBeUndefined();
    expect(env.OK_HOSTED_AGENT).toBeUndefined();
  });
});

describe('okChildHome', () => {
  test('warns when a terminal cannot grant a managed home', () => {
    vi.mocked(homedir).mockReturnValueOnce('');
    const logger = { warn: vi.fn() };
    const { env } = buildShellEnv({ PATH: '/usr/bin' }, { platform: 'linux', logger });
    expect(env.PATH).toBe('/usr/bin');
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'pty-host-no-ok-managed-home',
      platform: 'linux',
    });
  });

  test('normalizes an empty resolved home to absence', () => {
    vi.mocked(homedir).mockReturnValueOnce('');
    expect(okChildHome({ HOME: '' })).toBeUndefined();
  });

  test('returns absence when the operating system cannot resolve home', () => {
    vi.mocked(homedir).mockImplementationOnce(() => {
      throw new Error('no passwd entry');
    });
    expect(okChildHome({})).toBeUndefined();
  });

  test('prefers the parent env HOME, which is what the terminal producer passes', () => {
    expect(okChildHome({ HOME: '/Users/alice' })).toBe('/Users/alice');
  });

  test('falls back to the resolved home when the parent env carries none', () => {
    expect(okChildHome({})).toBe(homedir());
  });
});

describe('the terminal producer and the probe consumers derive the same home', () => {
  test.each([
    ['a parent env with HOME set', { PATH: '/usr/bin', HOME: '/Users/alice' }],
    ['a parent env with no HOME at all', { PATH: '/usr/bin' }],
  ])('%s yields one leading PATH entry for both sides', (_label, parentEnv) => {
    const options = okChildEnvOptions(parentEnv, { platform: 'darwin' });
    const consumer = composeOkChildEnv(parentEnv, options);
    const { env: producer } = buildShellEnv(parentEnv, { platform: 'darwin' });
    expect((producer.PATH ?? '').split(':')[0]).toBe((consumer.PATH ?? '').split(':')[0]);
  });
});
