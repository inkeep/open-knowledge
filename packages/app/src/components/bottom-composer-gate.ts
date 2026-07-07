/**
 * Pure visibility predicate for the bottom "Ask AI" composer.
 *
 * The composer is a doc-scoped affordance shown in both the desktop app and a
 * user's own browser. It shows only when every gate input clears:
 *   1. The docked terminal is closed (`!terminalVisible`). The open terminal
 *      owns the bottom of the editor column and is its own AI entry point, so
 *      the composer would contend with it for the same real estate.
 *   2. The host is not an embedded AI webview (`!isEmbedded`). When OK's preview
 *      is embedded inside a desktop agent (Claude Code / Codex / Cursor), that
 *      agent IS the AI surface, so a second dispatch affordance would be
 *      redundant — and the embed carries no separate installed-agent target.
 *   3. A document is open (`activeDocName !== null`). The empty/no-doc state
 *      already offers project/create handoff via AgentHandoffGrid, so a
 *      composer there would be a duplicate affordance.
 *
 * There is deliberately NO desktop-only gate: the composer deep-links to
 * locally-installed agents (and, on desktop only, the docked terminal), both of
 * which degrade cleanly in a browser — `useTerminalLaunch` is null on web so no
 * CLI rows appear, and the agent split-button shows its own empty state when the
 * `/api/installed-agents` probe finds none. Hiding it in the browser was an
 * oversight; only the embedded case (gate 2) suppresses it.
 *
 * Extracted from EditorArea into a pure function so each input contributes to
 * an independently testable truth table — mirrors `shouldPaintOverlay` and
 * `shouldShowAutoSyncOnboarding`.
 */
export interface BottomComposerGateInputs {
  /** Whether the docked terminal is currently visible. */
  terminalVisible: boolean;
  /** Whether the app runs inside an embedded AI-editor webview. */
  isEmbedded: boolean;
  /** The active document name, or null when no doc is open. */
  activeDocName: string | null;
}

export function shouldShowBottomComposer(inputs: BottomComposerGateInputs): boolean {
  return !inputs.terminalVisible && !inputs.isEmbedded && inputs.activeDocName !== null;
}

/**
 * Visibility predicate for the FOLDER-view bottom composer. The folder overview
 * renders its own composer docked below the folder list, scoped to the folder
 * (the folder is the top-row context chip + dispatch lead). It clears the same
 * embedded / terminal gates as the doc composer (gates 1-2) MINUS the
 * doc-open requirement — folder scope has no open doc. The host already knows it
 * is in a folder view, so the `activeDocName` clause has no analogue here; this
 * is intentionally a 2-input predicate.
 */
export function shouldShowFolderComposer(
  inputs: Omit<BottomComposerGateInputs, 'activeDocName'>,
): boolean {
  return !inputs.terminalVisible && !inputs.isEmbedded;
}
