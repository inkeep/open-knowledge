import { describe, expect, test } from 'bun:test';

/**
 * Ship gate for the terminal's real-PTY output path: the no-precedent
 * backpressure + UTF-8-integrity flood seam. node-pty does not pump under Bun,
 * so the flood drives the real `terminal-manager` ↔ `pty-host` path against
 * real login shells in `pty-flood.harness.ts` under Node (a hard package engine,
 * >=24); this test runs that harness as a subprocess and fails unless all four
 * flood scenarios report green. Until this is green, the real-PTY output path
 * must not ship — nothing else proves the coalescer keeps the consumer
 * responsive, that pause/resume bounds in-flight memory, that multibyte UTF-8
 * survives intact, or that concurrent sessions (tabs) multiplexed through one
 * host isolate their backpressure and bytes from each other.
 */

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
