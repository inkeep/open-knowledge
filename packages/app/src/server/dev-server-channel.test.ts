import { resolveDesktopProductName } from '@inkeep/open-knowledge-core/constants/product';
import { describe, expect, test } from 'vitest';
import {
  applyDevServerChannel,
  devServerCliArgs,
  workspaceCliEntry,
} from './dev-server-channel.ts';

describe('applyDevServerChannel', () => {
  test('pnpm dev serves as the dev channel', () => {
    const env: Record<string, string | undefined> = {};
    applyDevServerChannel(env);
    expect(resolveDesktopProductName(env, '/usr/local/bin/node')).toBe('dev');
  });

  test('an explicit OK_CHANNEL still wins', () => {
    const env: Record<string, string | undefined> = { OK_CHANNEL: 'stable' };
    applyDevServerChannel(env);
    expect(resolveDesktopProductName(env, '/usr/local/bin/node')).toBe('stable');
  });

  test('a test-isolated run keeps the shipped identity', () => {
    const env: Record<string, string | undefined> = { OK_TEST_CONTENT_DIR: '/tmp/content' };
    applyDevServerChannel(env);
    expect(env.OK_CHANNEL).toBeUndefined();
  });
});

describe('devServerCliArgs', () => {
  const root = '/src/open-knowledge';
  const entry = workspaceCliEntry(root);

  test('a dev server runs its CLI children on the workspace build, which knows the dev channel', () => {
    expect(
      devServerCliArgs(
        root,
        { OK_CHANNEL: 'dev' },
        { nodePath: '/usr/local/bin/node', entryExists: () => true },
      ),
    ).toEqual(['/usr/local/bin/node', entry]);
    expect(entry).toBe('/src/open-knowledge/packages/cli/dist/cli.mjs');
  });

  test('falls back to the CLI on PATH when the workspace CLI is not built', () => {
    expect(
      devServerCliArgs(root, { OK_CHANNEL: 'dev' }, { entryExists: () => false }),
    ).toBeUndefined();
  });

  test('a dev server pinned to a shipped channel keeps the CLI on PATH', () => {
    expect(
      devServerCliArgs(root, { OK_CHANNEL: 'stable' }, { entryExists: () => true }),
    ).toBeUndefined();
  });
});
