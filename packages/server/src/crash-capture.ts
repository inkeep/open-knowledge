import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SERVER_CRASH_LOG } from '@inkeep/open-knowledge-core';
import { getLocalDir } from './config/paths.ts';
import { logsCurrentPath } from './telemetry-file-sink.ts';

export interface CrashRecord {
  timestamp: string;
  origin: string;
  error: { name: string; message: string; stack: string | null };
  pid: number;
  uptimeSec: number;
}

export function buildCrashRecord(err: unknown, origin: string): CrashRecord {
  const error =
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack ?? null }
      : { name: 'NonError', message: String(err), stack: null };
  return {
    timestamp: new Date().toISOString(),
    origin,
    error,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime() * 1000) / 1000,
  };
}

export function writeCrashArtifacts(projectDir: string, record: CrashRecord): void {
  const localDir = getLocalDir(projectDir);
  try {
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, SERVER_CRASH_LOG), `${JSON.stringify(record, null, 2)}\n`);
  } catch {}
  try {
    const logsPath = logsCurrentPath(projectDir);
    mkdirSync(dirname(logsPath), { recursive: true });
    const line = {
      level: 60,
      time: Date.parse(record.timestamp),
      name: 'crash',
      origin: record.origin,
      err: record.error,
      pid: record.pid,
      uptimeSec: record.uptimeSec,
      msg: `fatal ${record.origin} — process crashing`,
    };
    writeFileSync(logsPath, `${JSON.stringify(line)}\n`, { flag: 'a' });
  } catch {}
}

const capturedProjectDirs = new Map<string, number>();
let monitorRegistered = false;

function onMonitor(err: unknown, origin: string): void {
  try {
    const record = buildCrashRecord(err, origin);
    for (const projectDir of capturedProjectDirs.keys()) {
      writeCrashArtifacts(projectDir, record);
    }
  } catch {}
}

export interface CrashCaptureHandle {
  uninstall: () => void;
}

export function installCrashCapture(projectDir: string): CrashCaptureHandle {
  capturedProjectDirs.set(projectDir, (capturedProjectDirs.get(projectDir) ?? 0) + 1);
  if (!monitorRegistered) {
    monitorRegistered = true;
    process.on('uncaughtExceptionMonitor', onMonitor);
  }
  let uninstalled = false;
  return {
    uninstall: () => {
      if (uninstalled) return;
      uninstalled = true;
      const count = capturedProjectDirs.get(projectDir) ?? 0;
      if (count <= 1) capturedProjectDirs.delete(projectDir);
      else capturedProjectDirs.set(projectDir, count - 1);
    },
  };
}
