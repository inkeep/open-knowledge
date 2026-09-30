import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHelperBundleBinary } from '@inkeep/open-knowledge-core/helper-bundle';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(HERE, '../..');
const distDesktopDir = resolve(desktopRoot, 'dist-desktop');

function listDir(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function bundleExecutable(bundle: string): string | null {
  const plistPath = join(bundle, 'Contents/Info.plist');
  if (!existsSync(plistPath)) return null;
  const name = readFileSync(plistPath, 'utf8').match(
    /<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/,
  )?.[1];
  return name === undefined ? null : join(bundle, 'Contents/MacOS', name);
}

interface PackagedApp {
  readonly app: string;
  readonly executable: string | null;
  readonly helper: string | null;
}

function findPackagedApps(): readonly PackagedApp[] {
  return listDir(distDesktopDir)
    .filter((name) => name.startsWith('mac-'))
    .flatMap((subdir) =>
      listDir(join(distDesktopDir, subdir))
        .filter((name) => name.endsWith('.app'))
        .map((name) => join(distDesktopDir, subdir, name)),
    )
    .map((app) => {
      const frameworks = join(app, 'Contents/Frameworks');
      const servers = listDir(frameworks).filter((name) => name.endsWith(' Server.app'));
      const helper = servers.length === 1 ? bundleExecutable(join(frameworks, servers[0])) : null;
      return { app, executable: bundleExecutable(app), helper };
    });
}

const haveDarwin = process.platform === 'darwin';
const packagedApps = haveDarwin ? findPackagedApps() : [];

describe('packaged helper binary runs under ELECTRON_RUN_AS_NODE=1', () => {
  test('test environment gate (packaged build present)', (ctx) => {
    ctx.skip(!haveDarwin, `darwin-only test; platform=${process.platform}`);
    ctx.skip(
      packagedApps.length === 0,
      `no packaged app found under ${distDesktopDir}/mac-<arch>/ — run ` +
        `\`pnpm exec electron-builder --dir --publish never\` (or \`okdesk\`) to enable this test`,
    );
    expect(packagedApps.length).toBeGreaterThan(0);
  });

  describe.each(packagedApps.map((packaged) => [packaged.app, packaged] as const))(
    '%s',
    (_app, packaged) => {
      test('carries exactly one Server.app helper with an existing executable', () => {
        expect(packaged.helper, `${packaged.app} has no usable Server.app helper`).not.toBeNull();
        expect(existsSync(packaged.helper as string)).toBe(true);
      });

      test('the spawn-site resolver lands on that helper', () => {
        expect(packaged.executable).not.toBeNull();
        expect(resolveHelperBundleBinary(packaged.executable as string)).toBe(packaged.helper);
      });

      test('helper binary exits 0 with stdout under ELECTRON_RUN_AS_NODE=1 (no SIGTRAP)', () => {
        const result = spawnSync(
          packaged.helper as string,
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
      });

      test('helper binary loads Electron Framework via @rpath without dyld errors', () => {
        const result = spawnSync(packaged.helper as string, ['-e', 'process.exit(0)'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 10_000,
        });

        expect(result.stderr).not.toContain('Library not loaded');
        expect(result.stderr).not.toContain('Unable to find helper app');
        expect(result.status).toBe(0);
      });
    },
  );
});
