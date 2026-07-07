/**
 * No-orphan reap harness — RUN UNDER NODE, not Bun.
 *
 * Proves the OS-level no-orphan guarantee: a host that is SIGTERM'd (what
 * Electron's `utilityProcess.kill()` delivers) reaps its real node-pty shell
 * instead of orphaning it. node-pty's PTY-fd reads do not pump under Bun, so
 * this runs under Node; `pty-host-reap.test.ts` spawns it, reads the shell pid
 * it prints, SIGTERMs it, and asserts that pid is gone.
 *
 * Shape: spawn a real login shell, print `SHELLPID=<pid>` (the shell's own
 * `$$`), install the production reaping wiring (`installHostReaping`), then
 * idle until SIGTERM. The shell is `setsid`'d into its own session, so harness
 * exit alone would orphan it — only the reaping `pty.kill()` brings it down,
 * which is exactly the mechanism under test.
 */

import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  installHostReaping,
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

const require = createRequire(import.meta.url);

// node-pty's prebuilt `spawn-helper` ships mode 0644 (node-pty#850); a real PTY
// spawn fails with "posix_spawnp failed" until it is executable. The packaged
// app fixes this in afterPack; for the dev node_modules we chmod it here.
function ensureSpawnHelperExecutable(): void {
  const pkgDir = dirname(dirname(require.resolve('node-pty')));
  const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const { spawn } = require('node-pty') as { spawn: SpawnPty };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-reap-')));
  process.on('exit', () => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort tmpdir cleanup on the way out.
    }
  });

  let data = '';
  let handler: ((event: { data: unknown }) => void) | null = null;
  const handle = setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(msg: PtyHostOutgoingMessage) {
        if (msg.type === 'data') data += msg.data;
      },
    },
    spawn,
    env: process.env,
  });
  // The production wiring under test — reap the shell on host teardown.
  installHostReaping(handle, process);
  const send = (msg: PtyHostIncomingMessage): void => handler?.({ data: msg });

  send({ type: 'create', ptyId: 'reap', cwd: tmp, cols: 80, rows: 24 });

  // Wait for the shell, then ask it for its own pid. The echoed command keeps
  // the literal `$$`; only the evaluated line is `SHELLPID=<digits>`.
  const deadline = Date.now() + 15000;
  while (data.length === 0 && Date.now() < deadline) await sleep(15);
  send({ type: 'input', ptyId: 'reap', data: 'echo SHELLPID=$$\r' });
  let pid: number | null = null;
  while (pid === null && Date.now() < deadline) {
    const match = data.match(/SHELLPID=(\d+)/);
    if (match) pid = Number(match[1]);
    else await sleep(15);
  }
  if (pid === null) {
    console.error('reap-harness: shell never reported its pid');
    process.exit(1);
  }

  // Hand the pid to the parent gate, then idle until it SIGTERMs us — the
  // SIGTERM handler installed above reaps the shell and exits.
  process.stdout.write(`SHELLPID=${pid}\n`);

  // Hard cap so a missed signal can't wedge the parent test's runtime.
  await sleep(30000);
  handle.killActive();
  process.exit(2);
}

void main().catch((err) => {
  console.error(`reap-harness fatal: ${(err as Error).message}`);
  process.exit(1);
});
