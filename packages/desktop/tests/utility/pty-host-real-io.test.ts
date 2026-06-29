import { describe, expect, test } from 'bun:test';

const NODE = Bun.which('node');
const HARNESS = new URL('./pty-host.real-io-harness.ts', import.meta.url).pathname;

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
