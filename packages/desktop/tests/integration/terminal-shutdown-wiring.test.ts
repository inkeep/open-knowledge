import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const src = readFileSync(indexTsPath, 'utf-8');

const FIX = (what: string): string =>
  `\n[terminal-shutdown] ${what}\n\n` +
  `Electron closes every window before it emits will-quit, so an ordinary Quit reaps each live\n` +
  `terminal through killForWindow. Without the before-quit notice arriving first, those sessions\n` +
  `are logged window-closed and app-shutdown describes only the update paths, which is the exact\n` +
  `defect this wiring was added to fix. The manager-level tests cannot see it: they call\n` +
  `noteAppShutdown() directly, so they stay green while this registration rots.\n`;

describe('terminal shutdown-notice wiring (bypass-pin)', () => {
  const beforeQuitBody = (): string => {
    const handler = /app\.on\('before-quit',\s*\(\)\s*=>\s*\{([\s\S]*?)\n {2}\}\);/.exec(src);
    expect(
      handler,
      FIX('the before-quit handler is no longer recognisable at module scope.'),
    ).not.toBeNull();
    return handler?.[1] ?? '';
  };

  test('before-quit tells the reaper a quit began, ahead of any window teardown', () => {
    const body = beforeQuitBody();
    expect(
      /terminalReaper\?\.noteAppShutdown\(announcedShutdownCause\);/.test(body),
      FIX('before-quit no longer announces the marked cause to the terminal reaper.'),
    ).toBe(true);

    const notice = body.indexOf('noteAppShutdown');
    const snapshot = body.indexOf('captureWindowRestoreSnapshot');
    expect(
      snapshot,
      FIX(
        'captureWindowRestoreSnapshot is gone from before-quit, so the statement this clause ' +
          'orders the notice against no longer exists. Re-anchor the ordering check rather than ' +
          'letting it pass on an absent anchor.',
      ),
    ).toBeGreaterThan(-1);
    expect(
      notice < snapshot,
      FIX('the shutdown notice no longer precedes window teardown inside before-quit.'),
    ).toBe(true);
  });

  test('the notice is armed only where a shutdown is irrevocable', () => {
    const arms = src.match(/noteAppShutdown\(/g) ?? [];
    expect(
      arms.length,
      FIX(
        'noteAppShutdown is armed somewhere other than before-quit. The announced cause is never ' +
          'cleared, so arming it on a path that can be abandoned (a failed update relaunch) ' +
          'latches it and mislabels every later window close. killAll tags its own sessions, so ' +
          'the update paths do not need it.',
      ),
    ).toBe(1);
  });

  test('each shutdown path tells killAll its own lifecycle event', () => {
    const scoped: ReadonlyArray<readonly [RegExp, string, string]> = [
      [
        /prepareForRelaunch:\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s{8}\},/,
        'relaunch',
        'the relaunch preparation',
      ],
      [
        /electronAutoUpdater\.on\('before-quit-for-update',\s*\(\)\s*=>\s*\{([\s\S]*?)\n {2}\}\);/,
        'update-install',
        'the before-quit-for-update handler',
      ],
      [
        /const runTerminalQuitDrain = createTerminalQuitDrain\(\{([\s\S]*?)\n {2}\}\);/,
        'quit',
        'the quit drain',
      ],
    ];
    for (const [shape, cause, what] of scoped) {
      const found = shape.exec(src);
      expect(
        found,
        FIX(`${what} is no longer recognisable, so its cause cannot be checked.`),
      ).not.toBeNull();
      const body = found?.[1] ?? '';
      expect(
        body.includes(`killAll('${cause}')`),
        FIX(
          `${what} no longer passes '${cause}' to killAll. Checking the whole file would miss two ` +
            'handlers exchanging their causes, which is why each is scoped to its own body.',
        ),
      ).toBe(true);
    }

    const calls = src.match(/killAll\(/g) ?? [];
    expect(
      calls.length,
      FIX('a killAll call site was added or removed; every one has to name its own cause.'),
    ).toBe(3);
  });

  test('a restart driven by an update marks relaunch, in each path that needs it', () => {
    const setter =
      /const noteRestartPending = \(\): void => \{\s*announcedShutdownCause = '([a-z-]+)';\s*\};/.exec(
        src,
      );
    expect(
      setter,
      FIX('noteRestartPending no longer assigns announcedShutdownCause in a recognisable form.'),
    ).not.toBeNull();
    expect(
      setter?.[1],
      FIX(
        'the restart mark no longer sets relaunch, so both update-driven restarts announce an ' +
          'ordinary quit while the identifier and the call count stay unchanged.',
      ),
    ).toBe('relaunch');

    const sites: ReadonlyArray<readonly [RegExp, string, boolean]> = [
      [
        /relaunchApp:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s+\},/,
        "the Linux manual-install fallback's relaunch button",
        true,
      ],
      [
        /relaunch:\s*\(options\)\s*=>\s*\{([\s\S]*?)\n\s+\},/,
        "the bundle-replace detector's restart",
        false,
      ],
    ];
    for (const [shape, what, quitsHere] of sites) {
      const found = shape.exec(src);
      expect(
        found,
        FIX(`${what} is no longer recognisable, so its mark cannot be checked.`),
      ).not.toBeNull();
      const body = found?.[1] ?? '';
      expect(
        body.includes('noteRestartPending()'),
        FIX(`${what} no longer marks the cause, so it is recorded as an ordinary user quit.`),
      ).toBe(true);
      const quit = body.indexOf('quit()');
      expect(
        quit > -1,
        FIX(
          `${what} ${quitsHere ? 'no longer quits' : 'now quits'} in its own body, so the ordering ` +
            'this case declares for it no longer describes the code. Update the declaration and ' +
            'the assertion together rather than letting either pass on an absent anchor.',
        ),
      ).toBe(quitsHere);
      if (quitsHere) {
        expect(
          body.indexOf('noteRestartPending()') < quit,
          FIX(
            `${what} marks the cause after it quits. before-quit reads the marked value, so a ` +
              'mark that lands after the quit is read too late and the session records a quit.',
          ),
        ).toBe(true);
      }
    }

    const marks = src.match(/noteRestartPending\(\)/g) ?? [];
    expect(
      marks.length,
      FIX(
        'the number of restart marks no longer matches the sites this case enumerates. A mark ' +
          'added elsewhere announces a relaunch from a path nothing here checks; the bound and ' +
          'the enumerated sites move together.',
      ),
    ).toBe(sites.length);
  });

  test('the lifecycle line says which shutdown it is, with or without a terminal open', () => {
    const body = beforeQuitBody();
    expect(
      /getLogger\('lifecycle'\)\.info\(\{ cause: announcedShutdownCause \}, 'before-quit'\);/.test(
        body,
      ),
      FIX(
        'the before-quit lifecycle line no longer records the cause, so a relaunch and an ' +
          'ordinary quit are byte-identical in the log whenever no terminal session is open.',
      ),
    ).toBe(true);
  });
});
