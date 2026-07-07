import { describe, expect, test } from 'bun:test';
import { isProcessAlive } from '@inkeep/open-knowledge-server';

/**
 * No-orphan OUTCOME seam. Verifies the system property the feature requires:
 * killing a PTY host process leaves no surviving shell. Real shell +
 * real signal are required, and node-pty does not pump under Bun, so the drive
 * runs in `pty-host.reap-harness.ts` under Node; this test spawns it, reads the
 * shell pid it spawned, kills the host, and asserts the shell pid is gone.
 *
 * No-orphan is defense-in-depth — the explicit `installHostReaping` `pty.kill()`
 * (whose wiring is unit-tested in `pty-host.test.ts`) AND the OS backstop (the
 * pty master fd closing on host exit SIGHUPs the slave). So this is an outcome
 * test, not an installHostReaping-isolating one: SIGTERM exercises the graceful
 * explicit-reap path; SIGKILL is uncatchable and exercises the OS backstop
 * alone — both must leave no orphan, including under a forced host crash.
 */

const NODE = Bun.which('node');
const HARNESS = new URL('./pty-host.reap-harness.ts', import.meta.url).pathname;

async function readShellPid(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const match = buf.match(/SHELLPID=(\d+)/);
      if (match) return Number(match[1]);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`harness never reported SHELLPID; output so far:\n${buf}`);
}

async function waitForReaped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function assertNoOrphan(killSignal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const proc = Bun.spawn([NODE as string, HARNESS], { stdout: 'pipe', stderr: 'pipe' });
  let shellPid: number | null = null;
  try {
    shellPid = await readShellPid(proc.stdout, 20_000);
    // The shell is live before teardown.
    expect(isProcessAlive(shellPid)).toBe(true);
    // SIGTERM models Electron's utilityProcess.kill(); SIGKILL models a forced
    // host crash where no catchable handler can run.
    proc.kill(killSignal);
    expect(await waitForReaped(shellPid, 10_000)).toBe(true);
  } finally {
    if (shellPid !== null && isProcessAlive(shellPid)) {
      try {
        process.kill(shellPid, 'SIGKILL');
      } catch {
        // Already gone — fine.
      }
    }
    proc.kill('SIGKILL');
    await proc.exited;
  }
}

describe('PTY host — no orphan on host teardown (Node runtime)', () => {
  test('a SIGTERM to the host leaves no orphan shell (graceful reap path)', async () => {
    if (!NODE) {
      throw new Error(
        'node was not found on PATH but is required (package engines: >=24) to spawn a real PTY — node-pty is silent under Bun',
      );
    }
    await assertNoOrphan('SIGTERM');
  }, 60_000);

  test('a SIGKILL to the host leaves no orphan shell (OS backstop, no handler runs)', async () => {
    if (!NODE) {
      throw new Error(
        'node was not found on PATH but is required (package engines: >=24) to spawn a real PTY — node-pty is silent under Bun',
      );
    }
    await assertNoOrphan('SIGKILL');
  }, 60_000);
});
