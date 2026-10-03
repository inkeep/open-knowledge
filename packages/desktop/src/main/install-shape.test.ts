import { describe, expect, test } from 'vitest';
import { wrapperPathInBundle } from './bundle-paths.ts';
import { agentConnectionsAvailability, classifyInstallShape } from './install-shape.ts';

describe('classifyInstallShape', () => {
  test('darwin bundle → mac-bundle with Contents/Resources wrapper', () => {
    const shape = classifyInstallShape(
      'darwin',
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      {},
    );
    expect(shape).toEqual({
      kind: 'mac-bundle',
      wrapperPath: '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh',
    });
  });

  test('darwin non-bundle executable is unsupported', () => {
    expect(classifyInstallShape('darwin', '/usr/local/bin/electron', {})).toEqual({
      kind: 'unsupported',
    });
  });

  test('win32 NSIS layout → resources\\cli\\bin\\ok.cmd', () => {
    const shape = classifyInstallShape(
      'win32',
      'C:\\Users\\u\\AppData\\Local\\Programs\\OpenKnowledge\\OpenKnowledge.exe',
      {},
    );
    expect(shape).toEqual({
      kind: 'windows',
      installRoot: 'C:\\Users\\u\\AppData\\Local\\Programs\\OpenKnowledge',
      wrapperPath:
        'C:\\Users\\u\\AppData\\Local\\Programs\\OpenKnowledge\\resources\\cli\\bin\\ok.cmd',
    });
  });

  test('win32 non-exe is unsupported', () => {
    expect(classifyInstallShape('win32', 'C:\\weird\\electron', {})).toEqual({
      kind: 'unsupported',
    });
  });

  test('linux deb layout → resources/cli/bin/ok.sh', () => {
    const shape = classifyInstallShape('linux', '/opt/OpenKnowledge/openknowledge', {});
    expect(shape).toEqual({
      kind: 'linux',
      installRoot: '/opt/OpenKnowledge',
      wrapperPath: '/opt/OpenKnowledge/resources/cli/bin/ok.sh',
    });
  });

  test('linux AppImage launch (APPIMAGE env) declines persistent integrations', () => {
    const shape = classifyInstallShape('linux', '/tmp/.mount_OpenKnXYZ/openknowledge', {
      APPIMAGE: '/home/u/OpenKnowledge-x86_64.AppImage',
    });
    expect(shape).toEqual({ kind: 'appimage' });
  });

  test('unknown platform is unsupported', () => {
    expect(classifyInstallShape('freebsd', '/opt/ok/ok', {})).toEqual({ kind: 'unsupported' });
  });
});

describe('wrapperPathInBundle per-platform layouts', () => {
  test('darwin default stays byte-identical to the historical mapping', () => {
    expect(
      wrapperPathInBundle('/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge', 'darwin'),
    ).toBe('/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh');
  });

  test('win32 maps beside the exe under resources\\', () => {
    expect(wrapperPathInBundle('C:\\Programs\\OpenKnowledge\\OpenKnowledge.exe', 'win32')).toBe(
      'C:\\Programs\\OpenKnowledge\\resources\\cli\\bin\\ok.cmd',
    );
  });

  test('linux maps beside the executable under resources/', () => {
    expect(wrapperPathInBundle('/opt/OpenKnowledge/openknowledge', 'linux')).toBe(
      '/opt/OpenKnowledge/resources/cli/bin/ok.sh',
    );
  });
});

describe('agentConnectionsAvailability', () => {
  const devExe = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
  const packagedExe = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';

  test.each([
    ['plain unpackaged build', false, 'darwin', devExe, {}, { available: false, devBuild: true }],
    [
      'unpackaged build forced open',
      false,
      'darwin',
      devExe,
      { OK_M6B_FORCE: '1' },
      { available: true, devBuild: false },
    ],
    [
      'unpackaged build locked by OK_RECLAIM_DISABLE',
      false,
      'darwin',
      devExe,
      { OK_RECLAIM_DISABLE: '1' },
      { available: false, devBuild: false },
    ],
    [
      'unpackaged build forced open but locked by OK_RECLAIM_DISABLE',
      false,
      'darwin',
      devExe,
      { OK_M6B_FORCE: '1', OK_RECLAIM_DISABLE: '1' },
      { available: false, devBuild: false },
    ],
    [
      'unpackaged build forced open but locked by install shape',
      false,
      'linux',
      '/tmp/.mount_ok/openknowledge',
      { OK_M6B_FORCE: '1', APPIMAGE: '/home/u/OK.AppImage' },
      { available: false, devBuild: false },
    ],
    ['packaged build', true, 'darwin', packagedExe, {}, { available: true, devBuild: false }],
    [
      'packaged build in an unsupported shape',
      true,
      'darwin',
      '/usr/local/bin/OpenKnowledge',
      {},
      { available: false, devBuild: false },
    ],
  ] as const)('%s', (_label, isPackaged, platform, exe, env, expected) => {
    expect(agentConnectionsAvailability(isPackaged, platform, exe, env)).toEqual(expected);
  });
});
