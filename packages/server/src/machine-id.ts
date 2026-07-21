/**
 * Stable per-machine identity for process-lock ownership checks.
 *
 * `os.hostname()` is NOT stable on macOS — it follows the network-derived
 * kernel hostname (DHCP/DNS renames, user renames in System Settings), and a
 * rename makes every lock written under the old name look foreign. A lock
 * that looks foreign gets replaced even though its holder is alive on this
 * very machine, which is how duplicate servers per contentDir happen.
 *
 * Instead we mint a random UUID once and persist it at `~/.ok/machine-id`
 * (owner-only, mode 0600 — sibling of `~/.ok/auth.yml` and `~/.ok/logs/`).
 * Deliberately NOT a hardware identifier (IOPlatformUUID, /etc/machine-id):
 * those need platform-specific subprocess calls in the boot-critical lock
 * path, and writing persistent hardware IDs into lock files that can land on
 * shared volumes is a needless privacy leak.
 *
 * Scope note: the file lives under the user's home, so two OS user accounts
 * on one machine get different IDs. That is safe because every lock judgment
 * that involves a foreign/unknown machine ID falls back to local pid
 * liveness and fails CLOSED (collision, not stale-replace) — see
 * `acquireProcessLock`.
 *
 * Failure posture: if `~/.ok` is unreadable/unwritable, fall back to an
 * ephemeral per-process UUID. Locks written under an ephemeral ID look
 * foreign to every other process, which degrades to the same fail-closed
 * pid-liveness judgment — never to silent lock replacement.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getLogger } from './logger.ts';

/**
 * Accepts UUIDs and other short opaque tokens; rejects whitespace/control
 * garbage from a corrupt file so a truncated write can't produce an ID that
 * breaks lock-file JSON round-trips or log lines.
 */
const MACHINE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

let cachedMachineId: string | null = null;

export function machineIdFilePath(homedirOverride?: string): string {
  return join(homedirOverride ?? homedir(), '.ok', 'machine-id');
}

/**
 * Read (or mint) the stable machine ID. Cached per process after the first
 * call — the lock hot paths (acquire/read/release) must not re-hit disk.
 *
 * `homedirOverride` is test-only, mirroring `secrets-store.ts`.
 */
export function getMachineId(homedirOverride?: string): string {
  if (homedirOverride === undefined && cachedMachineId !== null) return cachedMachineId;

  const filePath = machineIdFilePath(homedirOverride);
  let id: string | null = null;
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (MACHINE_ID_RE.test(raw)) id = raw;
  } catch {
    // Missing or unreadable — mint below.
  }

  if (id === null) {
    id = randomUUID();
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${id}\n`, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      // Unwritable home — keep the ephemeral ID for this process. Foreign-ID
      // judgments fail closed on pid liveness, so this degrades safely — but
      // loudly: every collision error this process later hits will blame
      // "already running" while the real root cause is this write failure.
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
