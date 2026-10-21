import type { DockMoveSide } from '@inkeep/open-knowledge-core/commands/command-identity';
import type { PaneId } from '@/lib/pane-visibility-store';

export interface DockPaneMove {
  readonly pane: PaneId;
  readonly side: DockMoveSide;
}

const handlers = new Set<(move: DockPaneMove) => void>();

export function requestDockPaneMove(move: DockPaneMove): void {
  for (const handler of handlers) handler(move);
}

export function subscribeDockPaneMoves(handler: (move: DockPaneMove) => void): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
