#!/usr/bin/env -S npx tsx
/**
 * Lock-holder worker — used by `multi-project-locks.test.ts` to exercise
 * cross-process lock isolation.
 *
 * Acquires `<lockDir>/server.lock` with this worker's own pid, advertises its
 * (pid, server-port) on stdout, then waits for SIGTERM/SIGINT to release and
 * exit cleanly.
 *
 * Usage (invoked by the test, never directly):
 *   node --import tsx lock-worker.ts <lockDir> <serverPort>
 *
 * Output (one line, then waits):
 *   READY {"pid":12345,"serverPort":52001}
 */

import { acquireProcessLock } from '@inkeep/open-knowledge-server';

const [, , lockDirArg, serverPortArg] = process.argv;

if (!lockDirArg || !serverPortArg) {
  process.stderr.write(
    'lock-worker: usage: node --import tsx lock-worker.ts <lockDir> <serverPort>\n',
  );
  process.exit(64); // EX_USAGE
}

const serverPort = Number.parseInt(serverPortArg, 10);
if (!Number.isFinite(serverPort)) {
  process.stderr.write(`lock-worker: invalid port arg: ${serverPortArg}\n`);
  process.exit(64);
}

const metadata = { port: 0, worktreeRoot: lockDirArg, startedAt: new Date().toISOString() };

let serverHandle: ReturnType<typeof acquireProcessLock> | null = null;
try {
  serverHandle = acquireProcessLock({ lockName: 'server', lockDir: lockDirArg, metadata });
  serverHandle.updatePort(serverPort);
} catch (err) {
  process.stderr.write(
    `lock-worker(${process.pid}): acquire failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

// Print the READY line so the parent can correlate this worker's pid + port
// with the on-disk lock file. Flush stdout explicitly — the parent reads
// line-by-line.
const ready = JSON.stringify({ pid: process.pid, serverPort });
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
  // Use 0 (not 128 + signo) — the parent test treats clean exit as success.
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep the event loop alive — without this the process would exit immediately
// after the synchronous setup since there are no pending I/O callbacks.
const keepAlive = setInterval(() => {}, 1 << 30);
// Clear on shutdown via signal handlers; in clean exit path we never reach
// the clear, but the OS cleanup handles it.
process.on('exit', () => clearInterval(keepAlive));
