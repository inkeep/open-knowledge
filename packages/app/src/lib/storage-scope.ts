/**
 * Project scoping for the renderer's persistent storage names, the implementation of
 * precedent #59: every client storage surface adopts it here instead of rediscovering the
 * collision `provider-pool.ts` used to own privately.
 */
import { fnv1aDigest } from '@inkeep/open-knowledge-core';

export function scopedStorageKey(baseKey: string, namespace: string | null): string {
  if (namespace === null) return baseKey;
  return `${baseKey}:${projectDigest(namespace)}`;
}

export function projectDigest(namespace: string): string {
  return fnv1aDigest(namespace);
}
