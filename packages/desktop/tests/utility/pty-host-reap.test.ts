import { describe, expect, test } from 'bun:test';
import { isProcessAlive } from '@inkeep/open-knowledge-server';


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
    expect(isProcessAlive(shellPid)).toBe(true);
    proc.kill(killSignal);
    expect(await waitForReaped(shellPid, 10_000)).toBe(true);
  } finally {
    if (shellPid !== null && isProcessAlive(shellPid)) {
      try {
        process.kill(shellPid, 'SIGKILL');
      } catch {
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
