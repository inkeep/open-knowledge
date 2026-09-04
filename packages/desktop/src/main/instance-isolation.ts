import { basename, dirname, join } from 'node:path';

export function sanitizeInstanceName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
}

export function deriveInstanceUserDataDir(
  baseUserData: string,
  rawInstanceName: string,
): string | null {
  const safe = sanitizeInstanceName(rawInstanceName);
  if (safe.length === 0) return null;
  return join(dirname(baseUserData), `${basename(baseUserData)} (${safe})`);
}
