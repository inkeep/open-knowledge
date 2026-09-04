import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getLogger } from './logger.ts';

const MACHINE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

let cachedMachineId: string | null = null;

export function machineIdFilePath(homedirOverride?: string): string {
  return join(homedirOverride ?? homedir(), '.ok', 'machine-id');
}

export function getMachineId(homedirOverride?: string): string {
  if (homedirOverride === undefined && cachedMachineId !== null) return cachedMachineId;

  const filePath = machineIdFilePath(homedirOverride);
  let id: string | null = null;
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (MACHINE_ID_RE.test(raw)) id = raw;
  } catch {}

  if (id === null) {
    id = randomUUID();
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${id}\n`, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      getLogger('machine-id').warn(
        { path: filePath, err },
        `Failed to persist ${filePath} — using an ephemeral per-process id; ` +
          `lock ownership checks will fail closed (collision) instead of recognizing this machine: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (homedirOverride === undefined) cachedMachineId = id;
  return id;
}
