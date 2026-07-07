/**
 * Typed IPC event channels (main → renderer, push/broadcast pattern).
 *
 * Paired with `./ipc-channels.ts`'s request/response surface. Events are
 * fire-and-forget — no reply, no failure handling at the renderer (if the
 * preload listener throws, main continues). Renderer subscribes via preload-
 * side listener wrappers (electron/electron#33328 — returned unsubscribe
 * closures must retain the wrapped-listener reference for
 * `ipcRenderer.removeListener` to match).
 *
 * Main-process dispatch goes through `sendToRenderer` in `./ipc-send.ts` —
 * the typed wrapper that's the canonical path for main→renderer push
 * events. Direct `webContents.send(...)` calls are banned outside allowlisted
 * wrapper files by a lint rule.
 */

import type {
  OkDesktopConfig,
  OkLocalOpAuthEvent,
  OkLocalOpCloneEvent,
  OkMenuAction,
  OkPtyData,
  OkPtyExit,
  OkServerReclaimedInfo,
  OkServerRestartedInfo,
  OkServerVersionDriftInfo,
  OkShareReceivedPayload,
} from './bridge-contract.ts';
import type {
  McpWiringEditorDetection,
  McpWiringGlobalSkillDescriptor,
  McpWiringPathInstallDescriptor,
  OnboardingShowPayload,
} from './ipc-channels.ts';

export interface EventChannels {
  /** Informational — "we're about to switch, show loading state". */
  'ok:project:switching': { payload: { projectPath: string } };
  /** After a project switch: renderer re-exposes `window.okDesktop.config` + fires `onProjectSwitched` subscribers. */
  'ok:project:switched': { payload: OkDesktopConfig };
  /** Main → renderer menu-action dispatch (File → New Doc, Edit → Toggle Sidebar, etc.). */
  'ok:menu-action': { payload: OkMenuAction };
  /**
   * `autoUpdater.on('update-downloaded')` fan-out to every open BrowserWindow
   * so renderer Toast A ("Update downloaded" + "Relaunch now" action) can
   * render. Main gates firing to once-per-version via
   * `AppState.versionPendingInstall`.
   */
  'ok:update:downloaded': { payload: { version: string } };
  /**
   * Main → every window the instant one window's "Relaunch" click reaches the
   * `ok:update:relaunch-now` handler (after the `versionPendingInstall` gate).
   * Each renderer swaps its `update-downloaded` card to the button-less
   * "Relaunching to install the update…" in-progress state, so every window
   * shows consistent feedback during the up-to-10s server-teardown window
   * before `quitAndInstall()` — not just the window that was clicked. Without
   * it, the non-clicked windows keep showing the stale "…ready to install
   * [Relaunch]" banner for those seconds (and could fire a redundant relaunch).
   */
  'ok:update:relaunching': { payload: { version: string } };
  /**
   * Main → every window when a committed relaunch fails ASYNCHRONOUSLY — the
   * updater's `error` event fired while the relaunch was in flight, or the
   * no-quit watchdog elapsed with the process still alive. (A synchronous
   * `quitAndInstall()` throw also broadcasts this, alongside the IPC
   * rejection the clicked window already sees.) Main re-broadcasts
   * `ok:update:downloaded` in the same routine to re-arm the banner; this
   * event surfaces the failure itself. Renderers add the relaunch-error
   * notice under the same version-keyed id as the rejection path, so the
   * two routes dedupe to one card.
   */
  'ok:update:relaunch-failed': {
    payload: { version: string; message?: string; downloadUrl?: string };
  };
  /**
   * First-launch-post-update signal: main compared `app.getVersion()` to
   * `AppState.lastSeenVersion` at updater start and decided a version
   * transition happened. Renderer Toast B (`"Updated to Version ${VERSION}"`
   * + link to GitHub Releases).
   */
  'ok:update:whats-new': { payload: { version: string; releaseUrl: string } };
  /**
   * Main → every window after one window dismissed the what's-new notice
   * (`ok:update:whats-new-dismiss`). Each renderer removes its `whats-new-<version>`
   * card so the FYI clears everywhere — dismiss-one = dismiss-all. Idempotent: a
   * window that already cleared the notice no-ops.
   */
  'ok:update:whats-new-dismissed': { payload: { version: string } };
  /**
   * Stuck-update hint: main detected `>7 calendar days` since the last
   * successful update check AND `!stuckHintShown`. Renderer Toast C points
   * the user at the manual-download page. Fires at most once per installation.
   */
  'ok:update:stuck-hint': { payload: { downloadUrl: string } };
  /**
   * Main → renderer on an `openknowledge://open?project=…&doc=<name>` URL
   * that routed to this window. Renderer updates `location.hash` to open
   * the target doc — the existing hash-route listener handles the rest.
   *
   * `branch` is optional and additive — older emitters that don't set it
   * keep working unchanged, and consumers treat `null` / `undefined` /
   * absent identically (no branch). Carries the share-link's source branch
   * through to the renderer so the receive-flow can detect mismatches.
   *
   * `multiCandidate` is optional and additive: `true` iff the dispatcher's
   * candidate-selection evaluated more than one candidate. Powers the
   * single-clone suppression in `installDeepLinkListener`'s
   * dispatched-window toast — the toast only fires when the
   * dispatcher had a real disambiguation choice. Treat undefined /
   * false identically.
   *
   * `kind` discriminates whether `doc` is a single-doc path or a folder
   * path. `doc` carries the path string for both kinds today; a sibling
   * story makes the renderer's hash setter kind-aware. Threaded here so
   * the signal is available end-to-end.
   */
  'ok:deep-link': {
    payload: {
      doc: string;
      kind: 'doc' | 'folder';
      branch?: string | null;
      multiCandidate?: boolean;
      /**
       * `true` iff main's target-existence gate found the share's target
       * absent on the checked-out branch. The renderer's
       * `installDeepLinkListener` toasts "not on this branch yet" instead of
       * opening a blank editor. Absent / `false` → normal navigation.
       */
      targetMissing?: boolean;
    };
  };
  /**
   * Main → renderer on a share URL routed to this window. Carries the
   * discriminated parse result so the renderer can dispatch:
   *   - `kind: 'ok'` → `ShareReceiveDialog` opens with Q1/Q2/Q3 tree
   *   - `kind: 'unsupported-version'` → toast "Update OpenKnowledge to open this share."
   *   - `kind: 'invalid'` → toast "Invalid share URL."
   *
   * Main routes via `getFocusedWindow() ?? getAllWindows()[0]`. Source
   * (universal-link vs custom-scheme) is NOT propagated — main-process
   * diagnostic only.
   */
  'ok:share:received': { payload: OkShareReceivedPayload };
  /**
   * First-launch MCP consent — main dispatches ONCE per app boot after the
   * renderer invokes `ok:mcp-wiring:renderer-ready` (mount-ack handshake).
   * Payload carries all six editor detections (checkbox list pre-selected
   * per `detected`) plus the PATH-install descriptor that drives the
   * dialog's PATH toggle row. Renderer renders `<McpConsentDialog>` as a
   * modal overlay; dismiss via confirm / skip IPC invoke.
   */
  'ok:mcp-wiring:show': {
    payload: {
      detectedEditors: readonly McpWiringEditorDetection[];
      pathInstall: McpWiringPathInstallDescriptor;
      globalSkills: readonly McpWiringGlobalSkillDescriptor[];
    };
  };
  /**
   * Per-project consent dialog. Main dispatches once per Navigator
   * folder-pick that resolves to `kind: 'fresh'` from a dialog-path entry
   * point (Pick Existing Project, Recents, deep-link, drag-drop). Routed
   * back through the same Navigator renderer that picked the folder via
   * the renderer-ready mount-ack. Per-pick lifecycle: each folder pick
   * spawns a fresh dialog session; multiple sequential dialogs within one
   * Navigator boot are expected.
   */
  'ok:onboarding:show': {
    payload: OnboardingShowPayload;
  };
  /**
   * Editor-window toast for ancestor-promote or git-root-promote. Main
   * dispatches once on `did-finish-load` of a freshly-spawned editor when
   * either condition holds. Renderer renders via sonner with a 4 s auto-
   * dismiss. Toast suppressed on `'recents'` reopen — the user explicitly
   * chose the project from Recents.
   */
  'ok:onboarding:toast': {
    payload:
      | { readonly kind: 'ancestor-promote'; readonly ancestorPath: string }
      | {
          readonly kind: 'git-root-promote';
          readonly gitRoot: string;
          /** The sub-folder the user originally picked; surfaces in the
           * toast so the user can see what got promoted to what. */
          readonly pickedPath: string;
        }
      | {
          readonly kind: 'startup-reclaim';
          readonly mcp:
            | { readonly status: 'none' }
            | { readonly status: 'repaired'; readonly editors: readonly string[] }
            | { readonly status: 'failed'; readonly editors: readonly string[] };
          readonly path:
            | { readonly status: 'none' }
            | { readonly status: 'installed'; readonly summary: string }
            | { readonly status: 'failed'; readonly summary: string };
        }
      | {
          /** Sharing-mode `local-only` refused at consent time because at
           *  least one OK artifact path is tracked upstream. Renderer
           *  shows a longer sonner notification (no auto-dismiss) so the
           *  user has time to read the remediation. */
          readonly kind: 'sharing-refused-tracked';
          readonly tracked: readonly string[];
          readonly remediation: string;
        }
      | {
          /** User picked `local-only` but the picked folder has no git
           *  repo (and `initGit` was off). Brief advisory toast. */
          readonly kind: 'sharing-no-git';
          readonly requestedMode: 'local-only';
        };
  };

  /**
   * Streaming events for the pre-project Navigator local-op flows. Pair
   * with `ok:local-op:auth:start` / `ok:local-op:clone:start`. Events
   * carry the `streamId` returned by the start call so multiple in-flight
   * flows on the same channel can be disambiguated (currently we cap at
   * one, but the streamId design lets future renderer code subscribe to
   * specific flows).
   *
   * Auth events mirror the server-side `AuthEvent` discriminated union
   * (`verification` | `complete` | `error`); clone events mirror the raw
   * CLI shape (`progress` | `complete` with `dir` only | `error`) — the
   * IPC path doesn't need the HTTP relay's port chaining because main
   * spawns a new editor window directly at `dir`.
   */
  'ok:local-op:auth:event': {
    payload: { streamId: string; event: OkLocalOpAuthEvent };
  };
  'ok:local-op:clone:event': {
    payload: { streamId: string; event: OkLocalOpCloneEvent };
  };

  /**
   * Main → renderer push fired when the user picks the macOS View →
   * Expand All / Collapse All menu items. Renderer invokes the same
   * Pierre-tree iteration logic the sidebar's empty-space and folder
   * context menus use. Tree-scoped (NOT subtree) — the View menu items
   * are smart-hidden in main when no folder is in the appropriate state.
   * No payload — the signal IS the directive.
   */
  'ok:sidebar:expand-all': { payload: undefined };
  'ok:sidebar:collapse-all': { payload: undefined };

  /**
   * Main → renderer on attach when the server this window connected to has a
   * different version than the running app. Fired once per attach, on/after
   * `dom-ready` (so the renderer subscriber is mounted). Renderer surfaces a
   * cancelable "restart server" notification.
   */
  'ok:server-version-drift': { payload: OkServerVersionDriftInfo };
  /**
   * Main → renderer on a freshly-recreated window after a successful server
   * restart (`restartServer`). Renderer confirms the server now matches the
   * app. Delivered via the same `did-finish-load` path as `ok:onboarding:toast`.
   */
  'ok:server-restarted': { payload: OkServerRestartedInfo };
  /**
   * Main → renderer on a freshly-spawned window after a dev session auto-
   * terminated a foreign server on the project's contentDir and started its
   * own (act-then-inform). Renderer surfaces a disruption notice naming the
   * dropped-MCP side effect. Delivered via the same `did-finish-load` path as
   * `ok:server-restarted`.
   */
  'ok:server-reclaimed': { payload: OkServerReclaimedInfo };

  /**
   * Main → renderer coalesced PTY output. Main batches the utilityProcess's
   * node-pty reads on an 8-16ms timer and pushes one combined UTF-8 string
   * per tick. node-pty's StringDecoder keeps multibyte sequences intact per
   * read, and main only ever concatenates whole reads (never slices a
   * string), so codepoints never split across a coalesce boundary.
   */
  'ok:pty:data': { payload: OkPtyData };
  /**
   * Main → renderer when the shell exits, the PTY dies, or the spawn itself
   * fails. `error` is set only on spawn failure (resource exhaustion); a
   * normal exit carries `exitCode`/`signal`.
   */
  'ok:pty:exit': { payload: OkPtyExit };
}
