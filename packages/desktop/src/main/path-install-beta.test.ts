import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../shared/desktop-variant.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/desktop-variant.ts')>();
  return { ...actual, DESKTOP_VARIANT: actual.DESKTOP_VARIANTS.beta };
});

import {
  ensureCliOnPath,
  pathInstallMarkerPath,
  removePathShimFromRcFiles,
} from './path-install.ts';

const BETA_EXE = '/Applications/OpenKnowledge Beta.app/Contents/MacOS/OpenKnowledge Beta';
const BETA_WRAPPER = '/Applications/OpenKnowledge Beta.app/Contents/Resources/cli/bin/ok.sh';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ok-beta-path-install-'));
}

describe('Beta CLI path install', () => {
  test('isolates marker, shims, environment, and rc block from Stable', async () => {
    const userHome = home();
    const zshrc = join(userHome, '.zshrc');
    const stableBlock = '# >>> open-knowledge cli >>>\nstable\n# <<< open-knowledge cli <<<\n';
    writeFileSync(zshrc, stableBlock);

    const result = await ensureCliOnPath({
      executablePath: BETA_EXE,
      isPackaged: true,
      platform: 'darwin',
      home: userHome,
      bundleVersion: '0.77.7-beta.0',
      env: { HOME: userHome, SHELL: '/bin/zsh' },
      spawn: async () => ({ code: 0, stdout: '/usr/bin:/bin', stderr: '' }),
      consentDecision: { status: 'granted', at: '2026-09-23T00:00:00.000Z' },
    });

    expect(result.status).toBe('installed');
    const betaRoot = join(userHome, '.ok', 'variants', 'beta');
    expect(pathInstallMarkerPath(userHome)).toBe(join(betaRoot, 'path-install.json'));
    expect(readlinkSync(join(betaRoot, 'bin', 'ok-beta'))).toBe(BETA_WRAPPER);
    expect(readlinkSync(join(betaRoot, 'bin', 'open-knowledge-beta'))).toBe(BETA_WRAPPER);
    expect(readFileSync(join(betaRoot, 'env.sh'), 'utf8')).toContain(
      '$' + '{HOME}/.ok/variants/beta/bin',
    );
    const installedRc = readFileSync(zshrc, 'utf8');
    expect(installedRc).toContain(stableBlock);
    expect(installedRc).toContain('# >>> open-knowledge beta cli >>>');

    expect(
      removePathShimFromRcFiles({
        home: userHome,
        platform: 'darwin',
        env: { SHELL: '/bin/zsh' },
      }),
    ).toMatchObject({ status: 'removed' });
    const removedRc = readFileSync(zshrc, 'utf8');
    expect(removedRc).toContain(stableBlock);
    expect(removedRc).not.toContain('open-knowledge beta cli');
    expect(existsSync(join(userHome, '.ok', 'path-install.json'))).toBe(false);
  });
});
