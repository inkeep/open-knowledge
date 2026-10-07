import { describe, expect, it } from 'vitest';
import { DESKTOP_PRODUCTS, desktopChannelLabel, resolveDesktopProductName } from './product.ts';

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

  it('gives every channel its own deep-link scheme, keeping Stable on openknowledge', () => {
    expect(
      Object.fromEntries(
        Object.entries(DESKTOP_PRODUCTS).map(([name, p]) => [name, p.protocolScheme]),
      ),
    ).toEqual({
      stable: 'openknowledge',
      beta: 'openknowledge-beta',
    });
  });
});

describe('desktopChannelLabel', () => {
  it.each([
    ['stable', 'OpenKnowledge (Stable)'],
    ['beta', 'OpenKnowledge Beta'],
    ['cloud', 'OpenKnowledge (cloud)'],
  ])('%s is named %s', (channel, expected) => {
    expect(desktopChannelLabel(channel)).toBe(expected);
  });
});
