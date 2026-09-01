/**
 * Project scoping for the renderer's persistent storage names — the
 * implementation of `precedent #59`, which is the citable statement of the
 * rule. Home of the one thing every client storage surface has to obey, so a
 * new one adopts it instead of rediscovering the bug (`provider-pool.ts` used
 * to own this privately, which is why `replay-outbox.ts` shipped without it).
 */
import { fnv1aDigest } from '@inkeep/open-knowledge-core';

export function scopedStorageKey(baseKey: string, namespace: string | null): string {
  if (namespace === null) return baseKey;
  return `${baseKey}:${projectDigest(namespace)}`;
}

export function projectDigest(namespace: string): string {
  return fnv1aDigest(namespace);
}
