/**
 * Identity of the running kernel session, for crash detection's boot-time
 * scan: the value changes if and only if the kernel rebooted, so comparing
 * the previous session's recorded value against the current one separates
 * "the machine went down under the app" from "the app died on its own" with
 * exact string equality — no clock arithmetic, no slack windows.
 *
 * Fail-open by contract: `null` (unsupported platform, probe failure) means
 * "no epoch identity available" and callers must fall back to their
 * unclassified behavior rather than guessing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function readBootSessionUuid(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'darwin') {
      // Absolute binary path — packaged apps launch with a minimal PATH.
      const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      return normalize(out);
    }
    if (platform === 'linux') {
      return normalize(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
    }
    return null;
  } catch {
    return null;
  }
}

function normalize(raw: string): string | null {
  const value = raw.trim();
  return value === '' ? null : value;
}
