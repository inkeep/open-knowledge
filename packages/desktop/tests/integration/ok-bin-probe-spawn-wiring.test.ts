import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const DESKTOP_SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));
const INDEX_TS = join(DESKTOP_SRC, 'main', 'index.ts');

const FIX = (what: string): string =>
  `\n[ok-bin-probe-spawn] ${what}\n\n` +
  `OK Desktop creates and populates ~/.ok/bin unconditionally, and buildShellEnv (pty-host.ts)\n` +
  `prepends it to every shell the app spawns for the user. That is the contract #2405 shipped, and\n` +
  `pty-host.test.ts pins it on the producer side. The CLI-presence probe adapter is the other end\n` +
  `of that pair: it composes a child environment for a real shell, so it owes the same PATH.\n` +
  `Spawning it with the app process environment makes every CLI installed in ~/.ok/bin read as\n` +
  `absent, and the false negative is silent, because a non-zero exit is indistinguishable from a\n` +
  `genuine absence. The behavioral half of this pin is\n` +
  `tests/integration/ok-bin-child-spawn-path.test.ts. This file covers the four call sites, which\n` +
  `live in the Electron wiring root and cannot be imported under vitest.\n`;

const INDEX_SOURCE = readFileSync(INDEX_TS, 'utf-8');

const DETECTION_SITES = [
  'resolveTerminalClaudeReadiness',
  'resolveTerminalCliOnPath',
  'resolveTerminalCliInstalledMap',
];

function functionBody(src: string, name: string): string {
  return new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(src)?.[0] ?? '';
}

describe('every CLI-presence detection site routes through the shared probe adapter', () => {
  test('index.ts takes its probe adapter from probe-spawn.ts rather than defining its own', () => {
    const imported = /import \{([^}]*)\} from '\.\/probe-spawn\.ts';/.exec(INDEX_SOURCE)?.[1] ?? '';
    for (const name of ['realProbeSpawn', 'realProbeTimers']) {
      expect(
        imported,
        FIX(
          `index.ts does not import ${name} from ./probe-spawn.ts; a locally defined adapter can drift out of the PATH contract on its own.`,
        ),
      ).toContain(name);
    }
  });

  test.each(['runLoginShellProbe', 'runWindowsPathProbe'])(
    '%s is fed that one adapter, not a second one defined beside it',
    (runner) => {
      const call = new RegExp(`${runner}\\(\\s*([A-Za-z_$][\\w$]*)\\s*,`, 'g');
      const adapters = [...INDEX_SOURCE.matchAll(call)].map((match) => match[1]);
      expect(adapters.length, FIX(`${runner} is never called in index.ts.`)).toBeGreaterThan(0);
      expect(
        new Set(adapters),
        FIX(
          `${runner} is fed ${[...new Set(adapters)].join(', ')}; a second adapter can drift out of the PATH contract on its own.`,
        ),
      ).toEqual(new Set(['realProbeSpawn']));
    },
  );

  test.each(DETECTION_SITES)(
    '%s probes through probeLoginShellOnPath / probeWindowsPath',
    (site) => {
      const body = functionBody(INDEX_SOURCE, site);
      expect(body, FIX(`${site}() was not found in index.ts.`)).not.toBe('');
      expect(
        body.includes('probeLoginShellOnPath'),
        FIX(`${site}() no longer probes POSIX presence through probeLoginShellOnPath.`),
      ).toBe(true);
      expect(
        body.includes('probeWindowsPath'),
        FIX(`${site}() no longer probes Windows presence through probeWindowsPath.`),
      ).toBe(true);
    },
  );

  test('the slides status probe probes through probeLoginShellOnPath / probeWindowsPath', () => {
    const wiring =
      /isOnLoginPath:\s*async\s*\([^)]*\)\s*=>[\s\S]*?probeWindowsPath\([^)]*\)[\s\S]*?probeLoginShellOnPath\(\s*cliProbeArgs\(/g;
    expect(
      (INDEX_SOURCE.match(wiring) ?? []).length,
      FIX(
        'the ok:slides:dispatch probes no longer resolve slidev through probeLoginShellOnPath / probeWindowsPath.',
      ),
    ).toBe(1);
  });

  test('probeLoginShellOnPath and probeWindowsPath are the only presence probes index.ts wires', () => {
    const posixSites = (
      INDEX_SOURCE.match(/probePosix:\s*\([^)]*\)\s*=>\s*probeLoginShellOnPath\(/g) ?? []
    ).length;
    const windowsSites = (
      INDEX_SOURCE.match(/probeWindows:\s*\([^)]*\)\s*=>\s*probeWindowsPath\(/g) ?? []
    ).length;
    expect(
      [posixSites, windowsSites],
      FIX(
        `index.ts wires ${posixSites} POSIX and ${windowsSites} Windows presence probes; DETECTION_SITES lists ${DETECTION_SITES.length} (${DETECTION_SITES.join(', ')}). If you ADDED a detection site, add its function name to DETECTION_SITES above so its wiring gets pinned too. If you did not add one, a site stopped routing through the shared adapter.`,
      ),
    ).toEqual([DETECTION_SITES.length, DETECTION_SITES.length]);
  });
});
