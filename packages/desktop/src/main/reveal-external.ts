import { isAbsolute } from 'node:path';

export type RevealExternalResult =
  | { ok: true; outcome: 'revealed' | 'dismissed' }
  | { ok: false; reason: 'not-found' | 'invalid-path' | 'error' };

export interface RevealExternalDeps {
  readonly probe: (absPath: string) => 'exists' | 'missing' | 'unreadable';
  readonly confirmReveal: (absPath: string) => Promise<boolean>;
  readonly showItemInFolder: (absPath: string) => void;
}

export async function handleRevealExternal(
  absPath: unknown,
  deps: RevealExternalDeps,
): Promise<RevealExternalResult> {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (Array.from(absPath).some((ch) => ch.charCodeAt(0) < 0x20)) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (!isAbsolute(absPath)) return { ok: false, reason: 'invalid-path' };

  const probed = deps.probe(absPath);
  if (probed === 'missing') return { ok: false, reason: 'not-found' };
  if (probed === 'unreadable') return { ok: false, reason: 'error' };

  const confirmed = await deps.confirmReveal(absPath);
  if (!confirmed) return { ok: true, outcome: 'dismissed' };

  deps.showItemInFolder(absPath);
  return { ok: true, outcome: 'revealed' };
}
