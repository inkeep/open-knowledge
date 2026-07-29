/**
 * Wires the native editor context menu onto a window's webContents.
 *
 * The main process observes the `context-menu` event directly, so spellcheck
 * params and clipboard edit flags arrive without any renderer IPC. The gate for
 * the menu itself is `params.isEditable`: it shows on any editable field and is
 * suppressed everywhere else. Surfaces that own their right-click (asset chips,
 * file tree, editor tabs) `preventDefault()` in the renderer, which suppresses
 * this main-process event, so they never reach this handler.
 *
 * Editable, though, spans far more than the document body — the composer, a
 * rename field, any dialog input — so a row that only means something over a
 * document carries its own gate. Those read as capabilities the renderer pushes
 * and this handler samples fresh per right-click, the same shape as the
 * spell-check flag.
 *
 * Side-effecting capabilities (session, shell, persistence, popup) are injected
 * so the gate + action wiring are exercised by unit tests without mounting a
 * BrowserWindow; the pure template builder lives in `spellcheck-menu.ts`.
 */

import type {
  BuildSpellcheckMenuTemplateParams,
  SpellcheckMenuActions,
  SpellcheckMenuParams,
} from './spellcheck-menu.ts';

/**
 * The slice of Electron's `ContextMenuParams` the handler reads: the builder's
 * params plus the `isEditable` gate field. Declared structurally so the real
 * event params assign directly at the wiring site.
 */
export interface ContextMenuHandlerParams extends SpellcheckMenuParams {
  readonly isEditable: boolean;
}

/**
 * Narrow webContents surface — the methods the handler calls on the webContents
 * that fired the event. Structural subset of Electron's `WebContents` so a real
 * instance assigns directly and tests inject a fake without the electron module.
 */
export interface SpellcheckWebContents {
  on(
    event: 'context-menu',
    listener: (event: unknown, params: ContextMenuHandlerParams) => void,
  ): void;
  replaceMisspelling(text: string): void;
  showDefinitionForSelection(): void;
}

export interface SpellcheckContextMenuDeps {
  /**
   * Reads the current app-wide spell-check flag. Called fresh on every
   * right-click so a toggle (from this menu or the menu bar) is reflected
   * without re-attaching the listener.
   */
  readonly isSpellCheckEnabled: () => boolean;
  /**
   * Whether the view-in-source jump would do anything right now — read fresh
   * per right-click, from the state the renderer pushes on every mode and
   * active-document change. Main cannot derive this: it sees an editable
   * target, not which surface the target belongs to.
   */
  readonly canViewInSource: () => boolean;
  /** Flip app-wide spell checking: update the live session AND persist. */
  readonly setSpellCheckEnabled: (enabled: boolean) => void;
  /**
   * Teach the spellchecker the flagged word — on macOS this writes to the
   * OS custom dictionary: it persists and is shared with other Mac apps.
   */
  readonly addToDictionary: (word: string) => void;
  /** Hand a URL to the OS default browser (through the shared scheme gate). */
  readonly openExternal: (url: string) => void;
  /** Route the view-in-source jump back to the renderer over the existing
   *  menu-action channel — no new IPC channel and no document text in main. */
  readonly viewInSource: () => void;
  /** Build + pop the native menu for the assembled template params. */
  readonly popMenu: (input: BuildSpellcheckMenuTemplateParams) => void;
}

function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * Register the `context-menu` handler on `webContents`. Each right-click on an
 * editable target assembles the action callbacks from the injected capabilities
 * plus the firing webContents, reads the current spell-check flag, and hands the
 * result to `popMenu`. Non-editable targets get no menu.
 */
export function attachSpellcheckContextMenu(
  webContents: SpellcheckWebContents,
  deps: SpellcheckContextMenuDeps,
): void {
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const actions: SpellcheckMenuActions = {
      replaceMisspelling: (suggestion) => {
        webContents.replaceMisspelling(suggestion);
      },
      addToDictionary: (word) => {
        deps.addToDictionary(word);
      },
      setSpellCheckEnabled: (enabled) => {
        deps.setSpellCheckEnabled(enabled);
      },
      lookUp: () => {
        webContents.showDefinitionForSelection();
      },
      search: (query) => {
        deps.openExternal(googleSearchUrl(query));
      },
      viewInSource: () => {
        deps.viewInSource();
      },
    };
    deps.popMenu({
      params,
      spellCheckEnabled: deps.isSpellCheckEnabled(),
      canViewInSource: deps.canViewInSource(),
      actions,
    });
  });
}
