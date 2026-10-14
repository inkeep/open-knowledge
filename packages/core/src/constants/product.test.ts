import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentCliCommandName,
  DESKTOP_PRODUCTS,
  DEV_FALLBACK_CLI_REFUSAL,
  defaultToDevChannel,
  desktopChannelLabel,
  desktopProductForCliCommand,
  envWithoutDevChannel,
  isDevChannel,
  OkCliCommand,
  PACKAGED_DESKTOP_PRODUCT_NAMES,
  resolveDesktopProductName,
  userHomeDisplayPath,
} from './product.ts';

describe('resolveDesktopProductName', () => {
  it.each([
    ['/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge', 'stable'],
    ['/Applications/OpenKnowledge Beta.app/Contents/MacOS/OpenKnowledge Beta', 'beta'],
    [
      '/Applications/OpenKnowledge Beta.app/Contents/Frameworks/OpenKnowledge Beta Server.app/Contents/MacOS/OpenKnowledge Beta Helper',
      'beta',
    ],
    [
      '/Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Server.app/Contents/MacOS/OpenKnowledge Helper',
      'stable',
    ],
    ['C:\\Users\\me\\AppData\\Local\\Programs\\OpenKnowledge Beta\\OpenKnowledge Beta.exe', 'beta'],
    ['/opt/OpenKnowledge Beta/openknowledge-beta', 'beta'],
    ['/opt/OpenKnowledge/openknowledge', 'stable'],
    ['/usr/local/bin/node', 'stable'],
    ['/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'stable'],
  ] as const)('%s resolves to %s', (execPath, expected) => {
    expect(resolveDesktopProductName({}, execPath)).toBe(expected);
  });

  it('lets OK_CHANNEL override the executable', () => {
    expect(resolveDesktopProductName({ OK_CHANNEL: 'Beta' }, '/usr/local/bin/node')).toBe('beta');
    expect(
      resolveDesktopProductName(
        { OK_CHANNEL: 'stable' },
        '/Applications/OpenKnowledge Beta.app/Contents/MacOS/OpenKnowledge Beta',
      ),
    ).toBe('stable');
  });

  it('rejects an unknown OK_CHANNEL instead of guessing', () => {
    expect(() => resolveDesktopProductName({ OK_CHANNEL: 'nightly' }, '')).toThrow(/OK_CHANNEL/);
  });

  it('gives every channel a distinct MCP server name and chain tag', () => {
    const products = Object.values(DESKTOP_PRODUCTS);
    expect(new Set(products.map((p) => p.mcpServerName)).size).toBe(products.length);
    expect(new Set(products.map((p) => p.mcpChainTag)).size).toBe(products.length);
  });

  it('gives every channel a distinct user home and keychain service, keeping Stable unchanged', () => {
    const products = Object.values(DESKTOP_PRODUCTS);
    expect(new Set(products.map((p) => p.userHomeDirName)).size).toBe(products.length);
    expect(new Set(products.map((p) => p.keyringService)).size).toBe(products.length);
    expect(DESKTOP_PRODUCTS.stable.userHomeDirName).toBe('.ok');
    expect(DESKTOP_PRODUCTS.stable.keyringService).toBe('open-knowledge');
  });

  it('names each channel’s deb and rpm after its Linux executable', () => {
    expect(
      Object.fromEntries(
        Object.entries(DESKTOP_PRODUCTS).map(([name, p]) => [name, p.linuxPackageNames]),
      ),
    ).toEqual({
      stable: { deb: 'openknowledge', rpm: 'openknowledge' },
      beta: { deb: 'openknowledge-beta', rpm: 'openknowledge-beta' },
      dev: { deb: 'openknowledge-dev', rpm: 'openknowledge-dev' },
    });
    for (const product of Object.values(DESKTOP_PRODUCTS)) {
      expect(product.linuxPackageNames.deb).toBe(product.linuxExecutableName);
      expect(product.linuxPackageNames.rpm).toBe(product.linuxExecutableName);
    }
  });

  it('retires the package names each channel shipped before, and only its own', () => {
    expect(DESKTOP_PRODUCTS.stable.retiredLinuxPackageNames).toEqual({
      deb: [],
      rpm: ['OpenKnowledge'],
    });
    expect(DESKTOP_PRODUCTS.beta.retiredLinuxPackageNames).toEqual({
      deb: ['openknowledge-beta-desktop'],
      rpm: ['openknowledge-beta-desktop'],
    });
    const current = Object.values(DESKTOP_PRODUCTS).flatMap((p) => [
      p.linuxPackageNames.deb,
      p.linuxPackageNames.rpm,
    ]);
    const retired = Object.values(DESKTOP_PRODUCTS).flatMap((p) => [
      ...p.retiredLinuxPackageNames.deb,
      ...p.retiredLinuxPackageNames.rpm,
    ]);
    for (const name of retired) expect(current).not.toContain(name);
    for (const product of Object.values(DESKTOP_PRODUCTS)) {
      for (const name of product.retiredLinuxPackageNames.deb)
        expect(name).toMatch(/^[a-z0-9.+-]+$/);
    }
  });

  it('gives every channel its own deep-link scheme, keeping Stable on openknowledge', () => {
    expect(
      Object.fromEntries(
        Object.entries(DESKTOP_PRODUCTS).map(([name, p]) => [name, p.protocolScheme]),
      ),
    ).toEqual({
      stable: 'openknowledge',
      beta: 'openknowledge-beta',
      dev: 'openknowledge-dev',
    });
  });

  it('gives the dev channel its own home, keychain, MCP key and lock channel', () => {
    const dev = resolveDesktopProductName({ OK_CHANNEL: 'dev' }, '/usr/local/bin/node');
    expect(dev).toBe('dev');
    expect(DESKTOP_PRODUCTS[dev]).toMatchObject({
      userHomeDirName: '.ok-dev',
      keyringService: 'open-knowledge-dev',
      mcpServerName: 'open-knowledge-dev',
      protocolScheme: 'openknowledge-dev',
    });
  });

  it('never resolves an executable to dev, which ships no app', () => {
    const dev = DESKTOP_PRODUCTS.dev;
    for (const execPath of [
      `/Applications/${dev.productName}.app/Contents/MacOS/${dev.productName}`,
      `/opt/${dev.productName}/${dev.linuxExecutableName}`,
      `C:\\Programs\\${dev.productName}\\${dev.productName}.exe`,
    ]) {
      expect(resolveDesktopProductName({}, execPath)).toBe('stable');
    }
    expect(PACKAGED_DESKTOP_PRODUCT_NAMES).toEqual(['stable', 'beta']);
  });
});

describe('defaultToDevChannel', () => {
  it('selects dev when no channel is set', () => {
    const env: Record<string, string | undefined> = {};
    defaultToDevChannel(env);
    expect(env.OK_CHANNEL).toBe('dev');
    expect(isDevChannel(env)).toBe(true);
    expect(resolveDesktopProductName(env, '/usr/local/bin/node')).toBe('dev');
  });

  it.each(['stable', 'beta', 'Beta'])('keeps an explicit OK_CHANNEL=%s', (channel) => {
    const env: Record<string, string | undefined> = { OK_CHANNEL: channel };
    defaultToDevChannel(env);
    expect(env.OK_CHANNEL).toBe(channel);
    expect(isDevChannel(env)).toBe(false);
  });

  it('treats a blank OK_CHANNEL as unset', () => {
    const env: Record<string, string | undefined> = { OK_CHANNEL: '  ' };
    defaultToDevChannel(env);
    expect(env.OK_CHANNEL).toBe('dev');
  });
});

describe('desktopChannelLabel', () => {
  it.each([
    ['stable', 'OpenKnowledge (Stable)'],
    ['beta', 'OpenKnowledge Beta'],
    ['dev', 'OpenKnowledge Dev'],
    ['cloud', 'OpenKnowledge (cloud)'],
  ])('%s is named %s', (channel, expected) => {
    expect(desktopChannelLabel(channel)).toBe(expected);
  });
});

describe('channel CLI command name', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names ok on Stable', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(currentCliCommandName()).toBe('ok');
  });

  it('names ok-beta on Beta', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(currentCliCommandName()).toBe('ok-beta');
  });

  it('names ok-dev on the dev channel, a bare command name like every other channel', () => {
    vi.stubEnv('OK_CHANNEL', 'dev');
    expect(currentCliCommandName()).toBe('ok-dev');
    expect(desktopProductForCliCommand('ok-dev')).toBe(DESKTOP_PRODUCTS.dev);
  });

  it('maps a command name back to its product, and anything else to Stable', () => {
    expect(desktopProductForCliCommand('ok-beta')).toBe(DESKTOP_PRODUCTS.beta);
    expect(desktopProductForCliCommand('ok')).toBe(DESKTOP_PRODUCTS.stable);
    expect(desktopProductForCliCommand(null)).toBe(DESKTOP_PRODUCTS.stable);
    expect(desktopProductForCliCommand('open-knowledge-beta')).toBe(DESKTOP_PRODUCTS.stable);
  });

  it('names each product home folder for display', () => {
    expect(userHomeDisplayPath(DESKTOP_PRODUCTS.stable, 'secrets.yml')).toBe('~/.ok/secrets.yml');
    expect(userHomeDisplayPath(DESKTOP_PRODUCTS.beta, 'secrets.yml')).toBe(
      '~/.ok-beta/secrets.yml',
    );
  });
});

describe('envWithoutDevChannel', () => {
  it('drops the dev channel and keeps everything else', () => {
    expect(envWithoutDevChannel({ PATH: '/usr/bin', OK_CHANNEL: 'dev', EMPTY: undefined })).toEqual(
      {
        PATH: '/usr/bin',
      },
    );
  });

  it('drops the dev channel under any key casing, as a Windows environment can carry it', () => {
    expect(envWithoutDevChannel({ Path: 'C:\\Windows', ok_channel: ' Dev ' })).toEqual({
      Path: 'C:\\Windows',
    });
  });

  it('keeps a shipped channel, which every released CLI knows', () => {
    expect(envWithoutDevChannel({ OK_CHANNEL: 'beta' })).toEqual({ OK_CHANNEL: 'beta' });
  });
});

describe('OkCliCommand', () => {
  const checkoutCli = ['node', '/src/cli.mjs'];

  it('pins dev only on a CLI the host supplies', () => {
    const cli = OkCliCommand.resolve({
      host: { cliArgs: checkoutCli },
      env: { OK_CHANNEL: 'dev' },
    });
    expect(cli.runnerInvocation(['auth', 'login'])).toEqual({
      cliArgs: [...checkoutCli, 'auth', 'login'],
      cliEnv: { OK_CHANNEL: 'dev' },
    });
    expect(cli.refusalFor(['auth', 'login'])).toBeUndefined();
  });

  it('never hands dev to the CLI on PATH, which a released build may be', () => {
    const cli = OkCliCommand.resolve({ env: { OK_CHANNEL: 'dev' } });
    expect(cli.runnerInvocation(['auth', 'status'])).toEqual({
      cliArgs: ['open-knowledge', 'auth', 'status'],
      cliEnv: {},
    });
    expect(cli.spawn(['status'], { PATH: '/usr/bin', OK_CHANNEL: 'dev' })).toEqual({
      command: 'open-knowledge',
      args: ['status'],
      env: { PATH: '/usr/bin' },
    });
  });

  it.each([
    [['auth', 'login', '--json']],
    [['auth', 'pat', '--token-stdin']],
    [['auth', 'token']],
    [['auth', 'signout', '--host', 'github.com']],
    [['clone', '--json', 'https://github.com/o/r.git', '/tmp/r']],
    [['start', '--port', '0']],
  ])('refuses %j on every path when a dev build falls back to the CLI on PATH', (args) => {
    const cli = OkCliCommand.resolve({ env: { OK_CHANNEL: 'dev' } });
    expect(cli.refusalFor(args)).toBe(DEV_FALLBACK_CLI_REFUSAL);
    expect(cli.runnerInvocation(args)).toEqual({ refused: DEV_FALLBACK_CLI_REFUSAL });
    expect(cli.spawn(args, {})).toEqual({ refused: DEV_FALLBACK_CLI_REFUSAL });
    expect(() => cli.stdioServer(args)).toThrow(DEV_FALLBACK_CLI_REFUSAL);
    expect(() => cli.shellCommand(args, (part) => part)).toThrow(DEV_FALLBACK_CLI_REFUSAL);
  });

  it('tells the developer to build and restart, since the CLI is resolved once per launch', () => {
    expect(DEV_FALLBACK_CLI_REFUSAL).toContain('pnpm build');
    expect(DEV_FALLBACK_CLI_REFUSAL).toContain('restart this dev build');
    expect(DEV_FALLBACK_CLI_REFUSAL).not.toMatch(/retry/i);
  });

  it('lets a fallback dev build read through the CLI on PATH', () => {
    const cli = OkCliCommand.resolve({ env: { OK_CHANNEL: 'dev' } });
    expect(cli.refusalFor(['auth', 'status'])).toBeUndefined();
    expect(cli.refusalFor(['auth', 'git-credential'])).toBeUndefined();
    expect(cli.refusalFor(['share', 'owners', '--json'])).toBeUndefined();
  });

  it('pins a shipped non-Stable channel on any CLI', () => {
    expect(
      OkCliCommand.resolve({ host: { cliArgs: [] }, env: { OK_CHANNEL: 'beta' } }).runnerInvocation(
        [],
      ),
    ).toEqual({
      cliArgs: ['open-knowledge'],
      cliEnv: { OK_CHANNEL: 'beta' },
    });
  });

  it('pins nothing on Stable and refuses nothing', () => {
    const cli = OkCliCommand.resolve({ host: { cliArgs: ['ok'] }, env: { OK_CHANNEL: 'stable' } });
    expect(cli.runnerInvocation(['start'])).toEqual({ cliArgs: ['ok', 'start'], cliEnv: {} });
    expect(cli.refusalFor(['auth', 'login'])).toBeUndefined();
  });

  it('carries the channel with the argv into every form a caller can take', () => {
    const cli = OkCliCommand.resolve({
      host: { cliArgs: checkoutCli },
      env: { OK_CHANNEL: 'dev' },
    });
    expect(cli.spawn(['mcp'], { OK_CHANNEL: 'dev', HOME: '/h' })).toEqual({
      command: 'node',
      args: ['/src/cli.mjs', 'mcp'],
      env: { HOME: '/h', OK_CHANNEL: 'dev' },
    });
    expect(cli.stdioServer(['mcp'])).toEqual({
      command: 'node',
      args: ['/src/cli.mjs', 'mcp'],
      env: { OK_CHANNEL: 'dev' },
    });
    expect(cli.shellCommand(['auth', 'git-credential'], (part) => part)).toBe(
      'OK_CHANNEL=dev node /src/cli.mjs auth git-credential',
    );
  });

  it('applies a host overlay, where undefined removes an inherited key', () => {
    const cli = OkCliCommand.resolve({
      host: {
        cliArgs: ['/app/OpenKnowledge.exe', 'cli.mjs'],
        cliEnv: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined },
      },
      env: { OK_CHANNEL: 'stable' },
    });
    const spawn = cli.spawn([], { NODE_OPTIONS: '--inspect', PATH: 'C:\\Windows' });
    expect('env' in spawn && spawn.env).toEqual({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});
