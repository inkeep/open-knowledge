import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { isTerminalPlatform } from '../../src/shared/terminal-platform.ts';

/**
 * Gate wrapper for the real-shell-I/O seam. The actual PTY drive runs in an
 * isolated Node subprocess so native handles cannot leak into the Vitest worker.
 */

const HARNESS = new URL('./pty-host.real-io-harness.ts', import.meta.url).pathname;

describe('PTY host — real shell I/O (Node runtime)', () => {
  test.skipIf(!isTerminalPlatform(process.platform))(
    'real interactive shell round-trips a command, strips env markers, survives a kill, and reports a bad shell',
    () => {
      const proc = spawnSync(process.execPath, [HARNESS], { encoding: 'utf8' });
      const output = `${proc.stdout}${proc.stderr}`;
      if (proc.status !== 0) {
        throw new Error(`real-PTY harness failed (exit ${proc.status}):\n${output}`);
      }
      expect(output).toContain('HARNESS_RESULT ok=4 fail=0');
    },
    60_000,
  );
});
