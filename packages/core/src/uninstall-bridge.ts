/**
 * `window.okUninstall` — the contract between the desktop self-uninstall
 * window's React renderer and the Electron main process.
 *
 * Shape lives in core so the desktop package (which exposes it through
 * `contextBridge.exposeInMainWorld` and services it in main) and the app
 * package (which renders the screens) compile against one declaration instead
 * of two drifting copies. Pure interfaces, zero imports.
 *
 * The security posture the shape encodes: main sends a screen DOWN, the
 * renderer sends an opaque intent UP. No intent carries a filesystem path —
 * the picker answers with indexes into the list main handed it, so a renderer
 * that lies can only ever name projects main already chose to offer. Deletion
 * authorization, target derivation and the `/Applications` + realpath guards
 * stay in main, which never reads a path out of an intent.
 */

/** One project row the picker offers. `path` is display-only, sent downward. */
export interface UninstallProjectRow {
  readonly path: string;
  readonly open: boolean;
  readonly recent: boolean;
  readonly running: boolean;
}

/** A done/pending line in the completion screen's recap. */
export interface UninstallNoticeChecklistItem {
  readonly label: string;
  readonly detail?: string;
  /** `true` = already done; `false` = the one remaining action. */
  readonly done: boolean;
}

/** The confirm / completion / failure screens, which differ only in content. */
export interface UninstallNoticeScreen {
  readonly title: string;
  readonly subtitle?: string;
  readonly paragraphs: readonly string[];
  readonly checklist?: readonly UninstallNoticeChecklistItem[];
  readonly footnote?: string;
  /**
   * When set, renders a link with this text that asks main to reveal the
   * cleanup log. The log's path stays in main and never reaches the renderer.
   */
  readonly logRevealLabel?: string;
  /** Monospace scrollable block (the cleanup log). */
  readonly log?: string;
  readonly confirmLabel: string;
  /** When present the notice is a two-button question; closing means cancel. */
  readonly cancelLabel?: string;
  /** Style the confirm control as destructive. */
  readonly danger?: boolean;
}

/** What main asked this uninstall window to render. */
export type UninstallScreenSpec =
  | { readonly kind: 'picker'; readonly projects: readonly UninstallProjectRow[] }
  | { readonly kind: 'survey' }
  | { readonly kind: 'progress' }
  | { readonly kind: 'notice'; readonly notice: UninstallNoticeScreen };

/**
 * Everything the renderer can say. Deliberately closed and path-free.
 *
 * `selectedIndexes` indexes the `projects` array of the picker screen main
 * sent; main re-resolves them against its own candidate list and discards
 * anything out of range, so the worst a hostile renderer can do is select a
 * different subset of the projects main already collected.
 */
export type UninstallIntent =
  | { readonly kind: 'picker-confirm'; readonly selectedIndexes: readonly number[] }
  | { readonly kind: 'picker-cancel' }
  | {
      readonly kind: 'survey-send';
      readonly reason?: string;
      readonly note?: string;
      readonly email?: string;
    }
  | { readonly kind: 'survey-skip' }
  | { readonly kind: 'notice-confirm' }
  | { readonly kind: 'notice-cancel' }
  | { readonly kind: 'notice-reveal-log' };

/** `ready` is the renderer asking which screen it is; the rest are intents. */
export type UninstallDispatchRequest = { readonly kind: 'ready' } | UninstallIntent;

/**
 * `refused` is not an error path the renderer can recover from — it means the
 * sender is not a live uninstall window main is waiting on, or the payload
 * wasn't a recognizable intent. Main takes no action either way.
 */
export type UninstallDispatchResult =
  | { readonly kind: 'screen'; readonly screen: UninstallScreenSpec }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly reason: 'unknown-window' | 'invalid-intent' };

/**
 * The `window.okUninstall` surface. The one preload bundle serves every window
 * but exposes this only when `isUninstallPreload(process.argv)` holds; editor
 * windows get `okDesktop` instead and never see `okUninstall`.
 */
export interface OkUninstallBridge {
  /** Ask main which screen this window is. */
  ready(): Promise<UninstallDispatchResult>;
  /** Report a user action. Resolving does not mean the window stays open. */
  send(intent: UninstallIntent): Promise<UninstallDispatchResult>;
}
