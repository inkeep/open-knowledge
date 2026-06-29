import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDetachedSpawnArgs } from '../../src/main/resolve-detached-spawn-args.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(HERE, '../..');
const indexTsPath = resolve(desktopRoot, 'src/main/index.ts');

function innermostAppContainer(pathLike: string): string | null {
  const segments = pathLike.split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (
      segments[i]?.endsWith('.app') &&
      segments[i + 1] === 'Contents' &&
      segments[i + 2] === 'MacOS'
    ) {
      return segments.slice(0, i + 1).join('/');
    }
  }
  return null;
}

describe('detached-server spawn: macOS Dock visibility regression guard', () => {
  test('bypass-pin — index.ts must not call spawn(process.execPath, ...) directly', () => {
    const src = readFileSync(indexTsPath, 'utf-8');
    const bypass = /spawn\s*\(\s*process\.execPath\s*[,)]/;
    const match = bypass.exec(src);
    expect(
      match,
      `\n[dock-visibility] index.ts contains a direct \`spawn(process.execPath, ...)\` ` +
        `call.\n\n` +
        `That is exactly the regression this PR fixed: on packaged macOS, process.execPath ` +
        `is the parent .app's MacOS binary, and spawning it (even under ELECTRON_RUN_AS_NODE=1) ` +
        `triggers LaunchServices to register a duplicate Dock tile (the "exec" placeholder).\n\n` +
        `Route the spawn through resolveDetachedSpawnArgs() — see\n` +
        `  packages/desktop/src/main/resolve-detached-spawn-args.ts\n` +
        `which returns a structurally safe file argument on darwin packaged. The runtime-pin ` +
        `test below covers the resolver's behavior; this bypass-pin covers the spawn site itself.\n\n` +
        `If you intentionally need to spawn the parent binary directly (e.g. for non-detached ` +
        `cases not subject to LaunchServices), document the reason inline and update this test ` +
        `to scope the bypass-pin to the spawnDetachedServer callback specifically.\n`,
    ).toBeNull();
  });

  test('runtime pin — resolveDetachedSpawnArgs() returns a structurally safe shape on darwin packaged', () => {
    const parentAppPath = '/Applications/OpenKnowledge.app';
    const parentExecPath = `${parentAppPath}/Contents/MacOS/OpenKnowledge`;
    const bundleCliMjsPath = `${parentAppPath}/Contents/Resources/app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/cli.mjs`;
    const reactShellDistDir = `${parentAppPath}/Contents/Resources/app`;

    const result = resolveDetachedSpawnArgs({
      platform: 'darwin',
      isPackaged: true,
      parentExecPath,
      bundleCliMjsPath,
      reactShellDistDir,
      contentDir: '/tmp/some-project',
      spawnErrorLogFd: 5,
      env: { PATH: '/usr/bin' },
    });

    const fileApp = innermostAppContainer(result.file);
    const fileTriggersParentAppLaunch = fileApp === parentAppPath;

    const argv0 = (result.opts as { argv0?: string }).argv0;
    const argv0HasSafeOverride =
      typeof argv0 === 'string' && innermostAppContainer(argv0) !== parentAppPath;

    const ok = !fileTriggersParentAppLaunch || argv0HasSafeOverride;

    expect(
      ok,
      `\n[dock-visibility] resolveDetachedSpawnArgs returned a spawn shape that triggers\n` +
        `LaunchServices on darwin packaged builds:\n` +
        `  file:        ${result.file}\n` +
        `  opts.argv0:  ${argv0 ?? '(unset)'}\n` +
        `  innermost .app of file:   ${fileApp ?? '(none — file is outside any .app)'}\n` +
        `  innermost .app of argv0:  ${typeof argv0 === 'string' ? innermostAppContainer(argv0) : '(no argv0)'}\n\n` +
        `Either the file MUST resolve to a binary outside ${parentAppPath}/Contents/MacOS/\n` +
        `(non-.app Node host or a separate helper .app bundle), or opts.argv0 MUST override\n` +
        `to a path outside the parent .app's MacOS directory.\n`,
    ).toBe(true);
  });
});
