import { useSyncExternalStore } from 'react';

export interface AgentDiffView {
  agentId: string;
  agentName: string;
  agentColor: string;
  agentIcon?: string;
  docName: string;
  keptCount: number;
  maxVersions: number;
}

let current: AgentDiffView | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function openAgentDiff(view: AgentDiffView): void {
  current = view;
  notify();
}

export function setAgentDiffKept(keptCount: number): void {
  if (current === null) return;
  const clamped = Math.max(0, Math.min(keptCount, current.maxVersions));
  if (clamped === current.keptCount) return;
  current = { ...current, keptCount: clamped };
  notify();
}

export function setAgentDiffMax(agentId: string, docName: string, maxVersions: number): void {
  if (current === null || current.agentId !== agentId || current.docName !== docName) return;
  if (current.maxVersions === maxVersions) return;
  const wasAtNow = current.keptCount === current.maxVersions;
  const keptCount = wasAtNow ? maxVersions : Math.min(current.keptCount, maxVersions);
  current = { ...current, maxVersions, keptCount };
  notify();
}

export function closeAgentDiff(): void {
  if (current !== null) {
    current = null;
    notify();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): AgentDiffView | null {
  return current;
}

export function useAgentDiffView(): AgentDiffView | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
