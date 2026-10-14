import { isSameHash } from '@/lib/doc-hash';

let pendingWorkspaceHash: string | null = null;

export function noteWorkspaceHashWrite(hash: string): void {
  pendingWorkspaceHash = hash;
}

export function consumeWorkspaceHashWrite(currentHash: string): boolean {
  const pending = pendingWorkspaceHash;
  pendingWorkspaceHash = null;
  return pending !== null && isSameHash(currentHash, pending);
}
