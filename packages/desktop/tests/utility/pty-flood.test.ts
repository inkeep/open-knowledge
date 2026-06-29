import { describe, expect, test } from 'bun:test';

const NODE = Bun.which('node');
const HARNESS = new URL('./pty-flood.harness.ts', import.meta.url).pathname;

describe('PTY flood — backpressure + UTF-8 integrity (Node runtime)', () => {
  test('sustained multibyte floods stay responsive, bound in-flight via pause/resume, deliver bytes uncorrupted, and isolate concurrent sessions', () => {
    if (!NODE) {
      throw new Error(
        'node was not found on PATH but is required (package engines: >=24) to drive the real-PTY flood — node-pty produces no output under Bun',
      );
    }
    const proc = Bun.spawnSync([NODE, HARNESS], { stdout: 'pipe', stderr: 'pipe' });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    if (proc.exitCode !== 0) {
      throw new Error(`flood harness failed (exit ${proc.exitCode}):\n${output}`);
    }
    expect(output).toContain('HARNESS_RESULT ok=4 fail=0');
  }, 120_000);
});
