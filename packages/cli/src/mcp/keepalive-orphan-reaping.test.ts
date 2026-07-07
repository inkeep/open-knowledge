/**
 * Integration test for orphan reaping: an `ok mcp` server must
 * terminate when its launching host process dies, instead of surviving as a
 * `launchd`-reparented orphan whose keepalive WS keeps a stale agent-presence
 * entry "live" forever.
 *
 * Production mechanism this reproduces:
 *   A Claude desktop "local agent mode" session spawns a per-run embedded
 *   harness, which spawns `ok mcp`. When the run ends the harness exits, but
 *   `ok mcp` can outlive it — reparented to pid 1 (`launchd`) with its
 *   `/collab/keepalive` WS still open, so the server's 3s `bumpPresenceTs`
 *   heartbeat keeps the presence entry fresh past the client 5s TTL and server
 *   20s eviction and the ghost icon never clears. Observed in the wild as
 *   orphaned `ok mcp` PIDs with `ppid == 1`, fd0 a still-open socket (no stdin
 *   EOF), alive long after the host died.
 *
 * Why stdin EOF alone is insufficient (so the ppid watch is load-bearing):
 *   A clean disconnect closes stdin and `ok mcp` exits via its `'end'` handler.
 *   But when an intermediary (wrapper / Electron helper) holds the stdin write
 *   end open, EOF never arrives — only reparenting signals the host is gone.
 *   This test exercises exactly that case.
 *
 * Test fidelity (each choice load-bearing):
 *   - `OK_BUNDLE_PROXY=0`: without it, a dev/source `ok mcp` re-proxies to the
 *     INSTALLED app bundle and we'd test the shipped build, not this worktree.
 *   - stdin is a FIFO whose write end is held by a separate "keeper" process
 *     that survives the parent. This models the wrapper-held socket: killing
 *     the parent delivers NO stdin EOF, so only a genuine parent-death watch
 *     can make the process exit (a normal pipe or /dev/null would EOF).
 *   - `ok mcp` is spawned as a GRANDCHILD under an intermediate parent we
 *     SIGKILL; the grandchild reparents to launchd (ppid -> 1), exactly the
 *     production orphan condition.
 *
 * The downstream "WS close -> grace timer -> clearPresence" link is already
 * proven by `keepalive-presence-cleanup.test.ts`; this test pins the first
 * link — the process must exit when its host dies.
 *
 * Requires the cli + its workspace deps to be built to `dist/` (the package
 * `exports` resolve to `./dist/*` by default), which the normal turbo `^build`
 * gate provides before tests run.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/cli/src/mcp -> packages/cli/src/cli.ts (run from source via bun).
const CLI_ENTRY = join(HERE, '..', 'cli.ts');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

async function pollUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  return predicate();
}

describe('ok mcp orphan reaping (PRD-6917)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // best-effort teardown
      }
    }
  });

  test('ok mcp exits when its launching parent dies even if stdin never EOFs (no orphan to launchd)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-orphan-reaping-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const fifo = join(dir, 'mcp.stdin');
    execFileSync('mkfifo', [fifo]);
    const mcpErr = join(dir, 'mcp.err');
    writeFileSync(mcpErr, '');

    // Keeper: holds the FIFO write end open and survives the parent, so the
    // grandchild's stdin never EOFs. Detached + ignored stdio so it is fully
    // independent of this test process and the parent.
    const keeperScript = join(dir, 'keeper.mjs');
    writeFileSync(
      keeperScript,
      [
        "import { openSync } from 'node:fs';",
        // Open for write — blocks until the parent opens the read end, then
        // holds it open indefinitely.
        'openSync(process.argv[2], "a");',
        'setInterval(() => {}, 1 << 30);',
      ].join('\n'),
      'utf-8',
    );
    const keeper = spawn(process.execPath, [keeperScript, fifo], {
      detached: true,
      stdio: 'ignore',
    });
    keeper.unref();
    cleanups.push(() => killQuietly(keeper.pid));

    // Intermediate parent: opens the FIFO read end and spawns `ok mcp` with
    // it as stdin (stdout ignored, stderr -> file so a SIGKILL can't EPIPE
    // it). Reports the grandchild pid, then idles until we SIGKILL it.
    const parentScript = join(dir, 'parent.mjs');
    writeFileSync(
      parentScript,
      [
        "import { spawn } from 'node:child_process';",
        "import { openSync } from 'node:fs';",
        'const [cliEntry, fifoPath, errPath] = process.argv.slice(2);',
        'const rfd = openSync(fifoPath, "r");',
        'const efd = openSync(errPath, "a");',
        'const child = spawn(process.execPath, [cliEntry, "mcp"], {',
        '  cwd: process.cwd(),',
        '  stdio: [rfd, "ignore", efd],',
        // OK_BUNDLE_PROXY=0 so we exercise THIS worktree's cli, not the
        // installed app bundle it would otherwise re-proxy to.
        '  env: { ...process.env, OK_BUNDLE_PROXY: "0" },',
        '});',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source emitted into the spawned child script, not a template string in this file
        'process.stdout.write(`CHILDPID:${child.pid}\\n`);',
        'setInterval(() => {}, 1 << 30);',
      ].join('\n'),
      'utf-8',
    );

    const parent = spawn(process.execPath, [parentScript, CLI_ENTRY, fifo, mcpErr], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    cleanups.push(() => killQuietly(parent.pid));

    let stdoutBuf = '';
    parent.stdout.on('data', (chunk) => {
      stdoutBuf += String(chunk);
    });
    const gotPid = await pollUntil(() => /CHILDPID:(\d+)/.test(stdoutBuf), 15_000, 100);
    const match = stdoutBuf.match(/CHILDPID:(\d+)/);
    expect(gotPid && match).toBeTruthy();
    const childPid = Number(match?.[1]);
    cleanups.push(() => killQuietly(childPid));

    // Sanity: the grandchild must come up and stay up while parented. If it
    // exits here, the harness is broken (e.g. spurious stdin EOF), not the
    // behavior under test — fail loudly rather than as a false GREEN.
    const cameUp = await pollUntil(() => isAlive(childPid), 6_000, 100);
    expect(cameUp).toBe(true);
    // Prove it's a stable long-lived process while parented — but fail fast:
    // pollUntil returns true the instant it dies early, false after the full
    // 3s window if it stays alive (the desired outcome).
    const diedWhileParented = await pollUntil(() => !isAlive(childPid), 3_000, 250);
    expect(diedWhileParented).toBe(false);

    // Host dies: SIGKILL the parent. The grandchild reparents to launchd
    // (ppid -> 1); stdin stays open (keeper survives) so no EOF fires.
    killQuietly(parent.pid);

    // Contract: the grandchild must notice its host is gone and exit — the
    // ppid watch in startHostLivenessWatch detects the reparenting (no stdin
    // EOF arrives here) and fires shutdown(), which closes the keepalive WS.
    const exited = await pollUntil(() => !isAlive(childPid), 12_000, 250);
    expect(exited).toBe(true);
  }, 40_000);
});
