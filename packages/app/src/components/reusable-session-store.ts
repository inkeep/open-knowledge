import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { useSyncExternalStore } from 'react';

export type ReusableSession =
  | {
      readonly id: string;
      readonly kind: 'thread';
      readonly label: string;
      readonly agentId: string;
      readonly iconUrl?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'terminal';
      readonly label: string;
      readonly cli: TerminalCli;
    };

type DockSurface = 'agents' | 'terminal';
const bySurface = new Map<DockSurface, ReusableSession | null>();
let current: ReusableSession | null = null;
const listeners = new Set<() => void>();

function resolveCurrent(): ReusableSession | null {
  return bySurface.get('agents') ?? bySurface.get('terminal') ?? null;
}

function same(a: ReusableSession | null, b: ReusableSession | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.id !== b.id || a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'thread' && b.kind === 'thread') {
    return a.agentId === b.agentId && a.iconUrl === b.iconUrl;
  }
  if (a.kind === 'terminal' && b.kind === 'terminal') return a.cli === b.cli;
  return false;
}

export function publishReusableSession(surface: DockSurface, next: ReusableSession | null): void {
  if (bySurface.has(surface) && same(bySurface.get(surface) ?? null, next)) return;
  bySurface.set(surface, next);
  const resolved = resolveCurrent();
  if (same(current, resolved)) return;
  current = resolved;
  for (const listener of listeners) listener();
}

export function getReusableSession(): ReusableSession | null {
  return current;
}

export function subscribeReusableSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReusableSession(): ReusableSession | null {
  return useSyncExternalStore(subscribeReusableSession, getReusableSession, () => null);
}

export function _resetReusableSession(): void {
  bySurface.clear();
  current = null;
  listeners.clear();
}
