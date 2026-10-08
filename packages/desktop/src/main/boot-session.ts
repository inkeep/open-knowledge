import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { uptime } from 'node:os';

export function readBootSessionUuid(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'darwin') {
      const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 2_000,
        windowsHide: true,
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

export function readBootStartedAtMs(
  nowMs: number = Date.now(),
  readUptimeSeconds: () => number = uptime,
): number | null {
  try {
    const uptimeSeconds = readUptimeSeconds();
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) return null;
    return nowMs - Math.round(uptimeSeconds * 1000);
  } catch {
    return null;
  }
}

function normalize(raw: string): string | null {
  const value = raw.trim();
  return value === '' ? null : value;
}
