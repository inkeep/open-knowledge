#!/usr/bin/env -S npx tsx

import { acquireProcessLock } from '@inkeep/open-knowledge-server';

const [, , lockDirArg, serverPortArg] = process.argv;

if (!lockDirArg || !serverPortArg) {
  process.stderr.write(
    'lock-worker: usage: node --import tsx lock-worker.ts <lockDir> <serverPort>\n',
  );
  process.exit(64);
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

const ready = JSON.stringify({ pid: process.pid, serverPort });
process.stdout.write(`READY ${ready}\n`);

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    serverHandle?.release();
  } catch {}
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const keepAlive = setInterval(() => {}, 1 << 30);
process.on('exit', () => clearInterval(keepAlive));
