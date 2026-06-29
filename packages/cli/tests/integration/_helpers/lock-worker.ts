#!/usr/bin/env bun

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

const ready = JSON.stringify({ pid: process.pid, serverPort, uiPort });
process.stdout.write(`READY ${ready}\n`);

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    serverHandle?.release();
  } catch {}
  try {
    uiHandle?.release();
  } catch {}
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const keepAlive = setInterval(() => {}, 1 << 30);
process.on('exit', () => clearInterval(keepAlive));
