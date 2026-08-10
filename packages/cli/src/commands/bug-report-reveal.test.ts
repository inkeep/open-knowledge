import { describe, expect, test, vi } from 'vitest';
import { revealBundle } from './bug-report-reveal.ts';

/**
 * Pins the exact command + argv `revealBundle` hands the detached spawner per
 * platform — including a path containing a space, the shape that broke
 * Explorer's `/select,<path>` verb (Node quotes a spaced argv element, and a
 * quoted `"/select,…"` stops parsing as a switch). Windows and Linux therefore
 * pass a single bare directory argument, which quotes cleanly.
 */
describe('revealBundle argv shape', () => {
  const SPACED = '/Users/Jane Doe/.ok/bug-reports/2026-08-04-bugreport.zip';

  test('darwin selects the file via open -R', () => {
    const spawn = vi.fn();
    revealBundle(SPACED, 'darwin', spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/open', ['-R', SPACED]);
  });

  test('win32 opens the containing folder — never the /select, verb', () => {
    const spawn = vi.fn();
    revealBundle('C:\\Users\\Jane Doe\\.ok\\bug-reports\\report.zip', 'win32', spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('explorer.exe');
    expect(args).toHaveLength(1);
    // On a darwin-run test suite node:path is posix, so pin the invariants
    // rather than the separator-specific dirname result: one bare directory
    // argument, no /select, verb glued to the path.
    expect(args[0]).not.toContain('/select,');
    expect(args[0]).not.toContain('report.zip');
  });

  test('linux opens the containing folder via xdg-open', () => {
    const spawn = vi.fn();
    revealBundle(SPACED, 'linux', spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('xdg-open', ['/Users/Jane Doe/.ok/bug-reports']);
  });

  test('a throwing spawner is swallowed — reveal is a best-effort nicety', () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn failed');
    });
    expect(() => revealBundle(SPACED, 'darwin', spawn)).not.toThrow();
  });
});
