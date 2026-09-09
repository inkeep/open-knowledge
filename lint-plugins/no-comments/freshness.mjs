import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ABSENT_SOURCE = 'absent';

export function sourceDigest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    return error?.code === 'ENOENT' ? ABSENT_SOURCE : null;
  }
}

export function isFresh(cached, digest) {
  return cached !== undefined && digest !== null && cached.digest === digest;
}
