/**
 * agent-diff-store — cross-component channel for the full-pane Agent edit diff.
 * The Agent Activity panel (right DocPanel) picks a file + version; EditorArea
 * (center pane) reads it and paints `AgentDiffPane` as a full-pane overlay over
 * the editor. A module store (not DocumentContext) keeps this isolated from the
 * central context + its test surface, matching `timeline-diff-store` and the
 * app's other `*-store` channels.
 *
 * The view is a file *version*: `keptCount` edits applied (0 = the pre-agent
 * original, `maxVersions` = now). The pane shows the whole file at that version,
 * so scrubbing the undo slider walks the file's history. The overlay is per-doc:
 * EditorArea paints it only while `docName` matches the open document and
 * navigates to that doc on open (an agent's edits can span other files).
 */
import { useSyncExternalStore } from 'react';

export interface AgentDiffView {
  /** Agent connection id — used to fetch each version's diff. */
  agentId: string;
  /** Agent header metadata for the pane header (precomputed by the panel). */
  agentName: string;
  agentColor: string;
  agentIcon?: string;
  /** Extension-less doc the version belongs to (matched against the open doc). */
  docName: string;
  /** Version shown: 0 = original (pre-edit), `maxVersions` = now (all edits). */
  keptCount: number;
  /** Total edits on this file — the top of the version range. */
  maxVersions: number;
}

let current: AgentDiffView | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Open the full-pane diff at a file version. Replaces any currently-open one. */
export function openAgentDiff(view: AgentDiffView): void {
  current = view;
  notify();
}

/** Set the shown version (clamped to `0..maxVersions`). No-op when closed. */
export function setAgentDiffKept(keptCount: number): void {
  if (current === null) return;
  const clamped = Math.max(0, Math.min(keptCount, current.maxVersions));
  if (clamped === current.keptCount) return;
  current = { ...current, keptCount: clamped };
  notify();
}

/**
 * Update the version ceiling for the open file from live activity (a new burst
 * landed / an undo committed). If the handle was pinned to "now" it follows to
 * the new top; otherwise it just clamps into range. No-op unless a diff for
 * this (agentId, docName) is open and the ceiling actually changed.
 */
export function setAgentDiffMax(agentId: string, docName: string, maxVersions: number): void {
  if (current === null || current.agentId !== agentId || current.docName !== docName) return;
  if (current.maxVersions === maxVersions) return;
  const wasAtNow = current.keptCount === current.maxVersions;
  const keptCount = wasAtNow ? maxVersions : Math.min(current.keptCount, maxVersions);
  current = { ...current, maxVersions, keptCount };
  notify();
}

/** Close the full-pane diff (no-op when already closed). */
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

/** Subscribe to the active full-pane agent diff (null when none is open). */
export function useAgentDiffView(): AgentDiffView | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
