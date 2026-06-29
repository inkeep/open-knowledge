import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HELPER_BUNDLE_NAME,
  HELPER_EXECUTABLE_NAME,
} from '@inkeep/open-knowledge-core/helper-bundle';

const HERE = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(HERE, '../..');
const distDesktopDir = resolve(desktopRoot, 'dist-desktop');

function findPackagedHelperBinary(): string | null {
  if (!existsSync(distDesktopDir)) return null;
  let macSubdirs: readonly string[];
  try {
    macSubdirs = readdirSync(distDesktopDir).filter((name) => name.startsWith('mac-'));
  } catch {
    return null;
  }
  for (const subdir of macSubdirs) {
    const candidate = join(
      distDesktopDir,
      subdir,
      'OpenKnowledge.app',
      'Contents/Frameworks',
      HELPER_BUNDLE_NAME,
      'Contents/MacOS',
      HELPER_EXECUTABLE_NAME,
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const haveDarwin = process.platform === 'darwin';
const packagedHelperBinary = haveDarwin ? findPackagedHelperBinary() : null;
const havePackagedBuild = packagedHelperBinary !== null;

describe('packaged helper binary runs under ELECTRON_RUN_AS_NODE=1', () => {
  test('test environment gate (packaged build present)', () => {
    if (!haveDarwin) {
      console.log(
        `[packaged-helper-runs-as-node] platform=${process.platform} — darwin-only test, skipping`,
      );
      return;
    }
    if (!havePackagedBuild) {
      console.log(
        `[packaged-helper-runs-as-node] no packaged helper binary found under ` +
          `${distDesktopDir}/mac-<arch>/OpenKnowledge.app/... — run ` +
          `\`bunx electron-builder --dir --publish never\` (or \`okdesk\`) to enable this test`,
      );
      return;
    }
    expect(existsSync(packagedHelperBinary as string)).toBe(true);
  });

  test.skipIf(!havePackagedBuild)(
    'helper binary exits 0 with stdout under ELECTRON_RUN_AS_NODE=1 (no SIGTRAP)',
    () => {
      const helperPath = packagedHelperBinary as string;
      const result = spawnSync(
        helperPath,
        ['-e', 'console.log("ok-helper-node-mode", process.versions.node)'],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 10_000,
        },
      );

      expect({
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderrTail: result.stderr.slice(-200),
      }).toEqual({
        status: 0,
        signal: null,
        stdout: expect.stringMatching(/ok-helper-node-mode\s+\d+\.\d+\.\d+/),
        stderrTail: '',
      });
    },
  );

  test.skipIf(!havePackagedBuild)(
    'helper binary loads Electron Framework via @rpath without dyld errors',
    () => {
      const helperPath = packagedHelperBinary as string;
      const result = spawnSync(helperPath, ['-e', 'process.exit(0)'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(result.stderr).not.toContain('Library not loaded');
      expect(result.stderr).not.toContain('Unable to find helper app');
      expect(result.status).toBe(0);
    },
  );
});
