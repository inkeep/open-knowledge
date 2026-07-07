import { describe, expect, test } from 'bun:test';

/**
 * Gate wrapper for the real-shell-I/O seam. node-pty does not pump under Bun,
 * so the actual PTY drive runs in `pty-host.real-io-harness.ts` under Node
 * (a hard package engine, >=24); this test runs that harness as a subprocess
 * and fails if it does not report all scenarios green.
 */

const NODE = Bun.which('node');
const HARNESS = new URL('./pty-host.real-io-harness.ts', import.meta.url).pathname;

// macOS-only: the docked terminal ships on macOS, and the real login-shell
// round-trip is environment-sensitive on the Linux CI runner (node-pty's
// PTY-fd reads are libuv-driven and the interactive-shell echo timing differs),
// which made it fail deterministically there while passing on macOS. The seam's
// CI coverage lives on the macOS `preflight` cell instead (see
// .github/workflows/public-open-knowledge-validation.yml). Runs unconditionally
// in local macOS dev.
const IS_DARWIN = process.platform === 'darwin';

describe('PTY host — real shell I/O (Node runtime)', () => {
  test.skipIf(!IS_DARWIN)(
    'real login shell round-trips a command, strips env markers, survives a kill, and reports a bad shell',
    () => {
      if (!NODE) {
        throw new Error(
          'node was not found on PATH but is required (package engines: >=24) to exercise the real-PTY seam — node-pty produces no output under Bun',
        );
      }
      const proc = Bun.spawnSync([NODE, HARNESS], { stdout: 'pipe', stderr: 'pipe' });
      const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
      if (proc.exitCode !== 0) {
        throw new Error(`real-PTY harness failed (exit ${proc.exitCode}):\n${output}`);
      }
      expect(output).toContain('HARNESS_RESULT ok=4 fail=0');
    },
    60_000,
  );
});
