#!/usr/bin/env bun
/**
 * Lock-holder worker — used by `multi-project-locks.test.ts` to exercise
 * cross-process lock isolation.
 *
 * Acquires `<lockDir>/server.lock` AND `<lockDir>/ui.lock` with this worker's
 * own pid, advertises its (pid, server-port, ui-port) on stdout, then waits
 * for SIGTERM/SIGINT to release and exit cleanly.
 *
 * Usage (invoked by the test, never directly):
 *   bun run lock-worker.ts <lockDir> <serverPort> <uiPort>
 *
 * Output (one line, then waits):
 *   READY {"pid":12345,"serverPort":52001,"uiPort":3001}
 */

import { acquireProcessLock } from '@inkeep/open-knowledge-server';

const [, , lockDirArg, serverPortArg, uiPortArg] = process.argv;

if (!lockDirArg || !serverPortArg || !uiPortArg) {
  process.stderr.write(
    'lock-worker: usage: bun run lock-worker.ts <lockDir> <serverPort> <uiPort>\n',
  );
  process.exit(64); // EX_USAGE
}

const serverPort = Number.parseInt(serverPortArg, 10);
const uiPort = Number.parseInt(uiPortArg, 10);
if (!Number.isFinite(serverPort) || !Number.isFinite(uiPort)) {
  process.stderr.write(`lock-worker: invalid port arg(s): ${serverPortArg} ${uiPortArg}\n`);
  process.exit(64);
}

const metadata = { worktreeRoot: lockDirArg, startedAt: new Date().toISOString() };

let serverHandle: ReturnType<typeof acquireProcessLock> | null = null;
let uiHandle: ReturnType<typeof acquireProcessLock> | null = null;
try {
  serverHandle = acquireProcessLock({ lockName: 'server', lockDir: lockDirArg, metadata });
  uiHandle = acquireProcessLock({ lockName: 'ui', lockDir: lockDirArg, metadata });
  serverHandle.updatePort(serverPort);
  uiHandle.updatePort(uiPort);
} catch (err) {
  process.stderr.write(
    `lock-worker(${process.pid}): acquire failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

// Print the READY line so the parent can correlate this worker's pid + ports
// with the on-disk lock files. Flush stdout explicitly — Bun buffers by
// default and the parent reads line-by-line.
const ready = JSON.stringify({ pid: process.pid, serverPort, uiPort });
process.stdout.write(`READY ${ready}\n`);

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    serverHandle?.release();
  } catch {
    // best-effort
  }
  try {
    uiHandle?.release();
  } catch {
    // best-effort
  }
  // Use 0 (not 128 + signo) — the parent test treats clean exit as success.
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep the event loop alive — without this, Bun would exit immediately
// after the synchronous setup since there are no pending I/O callbacks.
const keepAlive = setInterval(() => {}, 1 << 30);
// Clear on shutdown via signal handlers; in clean exit path we never reach
// the clear, but the OS cleanup handles it.
process.on('exit', () => clearInterval(keepAlive));
