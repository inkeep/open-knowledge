/**
 * VIEW_IN_SOURCE_EVENT — window CustomEvent that asks the editor pane to flip a
 * document into source mode for an explicit "view in source" jump.
 *
 * The jump command banks its landing target before dispatching, then relies on
 * this event to trigger the flip; `EditorPane` owns the mode state and listens.
 * Kept as a bare signal (no target payload) because the target already lives in
 * the pending-navigation store the incoming source view replays — the same split
 * the raw-MDX navigation uses.
 */

export const VIEW_IN_SOURCE_EVENT = 'open-knowledge:view-in-source';

export interface ViewInSourceDetail {
  docName: string;
}
