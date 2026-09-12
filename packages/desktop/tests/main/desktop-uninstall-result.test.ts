import { describe, expect, test } from 'vitest';
import {
  desktopUninstallResultCommand,
  desktopUninstallResultScreen,
  parseDesktopUninstallResultArgs,
  parseDesktopUninstallResultMessage,
} from '../../src/main/desktop-uninstall-result.ts';

const success = {
  title: 'OpenKnowledge files were removed',
  text: 'Removed settings.',
  actionLabel: 'Reveal in Finder',
} as const;

describe('uninstall completion window', () => {
  test('sends a success discriminator for verified cleanup', () => {
    expect(desktopUninstallResultScreen(success)).toEqual({ kind: 'result', outcome: 'success' });
  });
  test('sends a failure discriminator without inviting app removal', () => {
    expect(desktopUninstallResultScreen({ actionLabel: 'Close' })).toEqual({
      kind: 'result',
      outcome: 'failure',
    });
  });
  test('requires an isolated profile and a supported result action', () => {
    const args = [
      '--user-data-dir=/tmp/owned-profile',
      '--ok-uninstall-result',
      success.title,
      success.text,
      success.actionLabel,
    ];
    expect(parseDesktopUninstallResultArgs(args)).toEqual({
      profile: '/tmp/owned-profile',
      kind: 'result',
      ...success,
    });
    expect(parseDesktopUninstallResultArgs(args.slice(1))).toBeNull();
    expect(
      parseDesktopUninstallResultArgs(['--user-data-dir=relative', ...args.slice(1)]),
    ).toBeNull();
    expect(parseDesktopUninstallResultArgs([...args.slice(0, -1), 'Delete'])).toBeNull();
    expect(parseDesktopUninstallResultArgs([])).toBeNull();
  });
  test('launches the packaged entry or the explicit development app', () => {
    expect(
      desktopUninstallResultCommand(
        '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
        true,
        '/app.asar',
      ),
    ).toEqual(['/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge']);
    expect(desktopUninstallResultCommand('/dev/Electron', false, '/work/desktop')).toEqual([
      '/dev/Electron',
      '/work/desktop',
    ]);
  });
});

test('progress mode requires its own profile and cannot also supply a premature result', () => {
  expect(
    parseDesktopUninstallResultArgs(['--ok-uninstall-progress', '--user-data-dir=/tmp/owned']),
  ).toEqual({ kind: 'progress', profile: '/tmp/owned' });
  expect(parseDesktopUninstallResultArgs(['--ok-uninstall-progress'])).toBeNull();
  expect(
    parseDesktopUninstallResultArgs([
      '--ok-uninstall-progress',
      '--user-data-dir=/tmp/owned',
      '--ok-uninstall-result',
    ]),
  ).toBeNull();
});

test('accepts complete result messages and rejects truncated or unsupported results', () => {
  expect(parseDesktopUninstallResultMessage('Cleanup didn’t finish\0Keep state.\0Close\0')).toEqual(
    { title: 'Cleanup didn’t finish', text: 'Keep state.', actionLabel: 'Close' },
  );
  expect(
    parseDesktopUninstallResultMessage('Cleanup didn’t finish\0Keep state.\0Close'),
  ).toBeNull();
  expect(parseDesktopUninstallResultMessage('title\0text\0Delete\0')).toBeNull();
  expect(parseDesktopUninstallResultMessage('title\0text\0Close\0extra\0')).toBeNull();
});

test('carries a validated locale into the disposable profile', () => {
  const command = desktopUninstallResultCommand('/app', true, '/app.asar', 'es');
  expect(
    parseDesktopUninstallResultArgs([
      ...command,
      '--user-data-dir=/tmp/owned',
      '--ok-uninstall-progress',
    ]),
  ).toEqual({ kind: 'progress', profile: '/tmp/owned', locale: 'es' });
  expect(
    parseDesktopUninstallResultArgs([
      '--ok-uninstall-locale=garbage',
      '--user-data-dir=/tmp/owned',
      '--ok-uninstall-progress',
    ]),
  ).toBeNull();
});
