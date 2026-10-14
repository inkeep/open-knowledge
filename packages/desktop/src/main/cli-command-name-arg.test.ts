import { afterEach, describe, expect, test, vi } from 'vitest';
import { withCliCommandNameArg } from './cli-command-name-arg.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderer-window CLI command-name argv', () => {
  test('a Beta run hands the window its own command', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(withCliCommandNameArg(['--ok-mode=editor'])).toEqual([
      '--ok-mode=editor',
      '--ok-cli-command-name=ok-beta',
    ]);
  });

  test('a Stable run hands the window the Stable command', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(withCliCommandNameArg(['--ok-mode=editor'])).toEqual([
      '--ok-mode=editor',
      '--ok-cli-command-name=ok',
    ]);
  });
});
