/**
 * Install a subscriber for the Desktop `ok:deep-link` bridge event. When
 * an `openknowledge://` URL routes to this window, main fires the bridge
 * event with `{ doc, kind, branch? }`; this installer updates
 * `window.location.hash` so the existing hash-route listener in App opens
 * the target.
 *
 * The hash form dispatches on `evt.kind` (see `encodeShareTargetForHash`):
 *   - `kind: 'doc'` → `#/<doc>`, with `branch` riding as a `?branch=<encoded>`
 *     query param when present (mirrors the `?anchor=...` pattern in
 *     `doc-hash.ts`). Absent / null / empty branch keeps the bare `#/<doc>`
 *     form — back-compat with legacy emitters preserved.
 *   - `kind: 'folder'` → `#/<folderPath>/` (trailing-slash folder form),
 *     matching how in-app folder navigation builds its hash. An empty `doc`
 *     is the content-root sentinel → `#/` (contentDir root). No `?branch=`
 *     is appended: the branch-switch decision resolves upstream before the
 *     dispatched window navigates.
 *
 * Registered imperatively during main.tsx module init (not inside a React
 * effect) so the `ipcRenderer.on` listener is in place before the main process
 * fires the event on `dom-ready` or later.
 *
 * Dispatched-window toast: in the dispatched window of a multi-worktree
 * share-receive, emit a brief toast naming the branch + worktree path.
 * The deep-link payload carries the branch the share asked for; the
 * window already knows its own `projectPath` via `bridge.config`.
 *
 * Suppressed when:
 *   - the share carried no branch (legacy single-clone receivers'
 *     shares pre-branch-awareness — nothing useful to disambiguate)
 *   - the dispatcher signals `multiCandidate === false` / absent
 *     single-clone receivers — the user has one window matching the
 *     repo, so confirmation copy adds noise without disambiguation
 *     value)
 *
 * Toasts only when `multiCandidate === true`: the dispatcher's
 * candidate-selection had >1 entries, the user's window choice was
 * non-trivial, and the receiver benefits from knowing which window
 * the share landed in.
 *
 * No-op in web / CLI distribution (window.okDesktop undefined). In Desktop,
 * returns the bridge-provided unsubscribe so the caller can detach on
 * hot-module-replacement or teardown.
 */

import { toast } from 'sonner';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { encodeShareTargetForHash } from '@/lib/doc-hash';
import { missDialogStore } from '@/lib/share/miss-dialog-store';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

interface InstallDeepLinkListenerOptions {
  /** Bridge resolved from `window.okDesktop`. Absent in web/CLI. */
  bridge: OkDesktopBridge | undefined;
  /**
   * Hash-setter override for tests. Production: writes
   * `window.location.hash = '#/' + encodeURIComponent(doc)`.
   */
  setHash?: (hash: string) => void;
  /**
   * Toast emitter override for tests. Production: calls `sonner`'s
   * `toast(message, { description, duration })`. Tests pass a spy.
   */
  emitToast?: (message: string, opts: { description: string; duration: number }) => void;
}

/**
 * Pure helper: derive the share-receive toast payload from a deep-link
 * event and the window's projectPath. Returns null when the toast should
 * be suppressed (no branch, or no projectPath) so the call site never has
 * to repeat the branching. Extracted for unit testability — the toast()
 * call itself is side-effectful and lives in the bridge listener.
 */
export function deriveShareReceiveToast(
  evt: { doc: string; branch?: string | null; multiCandidate?: boolean },
  projectPath: string,
): { message: string; description: string } | null {
  // Toast keys off branch + multiCandidate only — kind-agnostic.
  if (evt.branch === undefined || evt.branch === null || evt.branch === '') return null;
  if (projectPath === '') return null;
  // Single-clone suppression: only emit the toast when the
  // dispatcher signals that selection evaluated more than one
  // candidate. Treat undefined / false identically — legacy emitters
  // and explicit single-clone dispatches collapse to "no toast." The
  // toast is dispatcher-disambiguation copy; without a real
  // disambiguation choice it is noise.
  if (evt.multiCandidate !== true) return null;
  return {
    message: `Opened on branch ${evt.branch}`,
    description: projectPath,
  };
}

export function installDeepLinkListener(
  opts: InstallDeepLinkListenerOptions,
): (() => void) | undefined {
  const bridge = opts.bridge;
  if (!bridge) return undefined;

  const setHash =
    opts.setHash ??
    ((hash: string) => {
      window.location.hash = hash;
    });
  const emitToast =
    opts.emitToast ??
    ((message: string, toastOpts: { description: string; duration: number }) => {
      toast(message, toastOpts);
    });
  return bridge.onDeepLink((evt) => {
    // `evt.kind` defaults to 'doc' for legacy emitters that predate
    // folder-share — those payloads carry no `kind`, and the doc form is the
    // back-compat target.
    const kind = evt.kind ?? 'doc';
    // Keep the share target's file extension: the verdict fetch needs the real
    // repo path, and both stores normalize for matching.
    const nav = { kind, path: evt.doc, branch: evt.branch ?? null };
    // Main's pre-nav stat probe already found the target absent on the
    // receiver's checked-out branch (deleted / renamed / not yet fetched). Show
    // the honest verdict as a modal WITHOUT navigating to the dead path — no
    // phantom tab is opened and create-mode can't fork. The in-tab
    // `pendingReceiveNav` panel stays the backstop for a miss discovered only
    // AFTER navigation (main said present, but the local ref no longer carries
    // it), which the branch below arms.
    if (evt.targetMissing === true) {
      missDialogStore.arm(nav);
      return;
    }
    // Arm the renderer's in-tab miss backstop before navigating, then navigate.
    // The store self-clears once navigation leaves this target, so a later
    // wiki-link to the same path is create-on-navigate again.
    pendingReceiveNavStore.arm(nav);
    // `branch` rides the hash as `?branch=` ONLY for doc shares (a
    // defense-in-depth signal for the renderer's branch-switch trigger). Folder
    // shares resolve the branch-switch upstream before navigation, so the folder
    // hash carries no branch — pass `undefined` so the drop is explicit at the
    // call site rather than silently discarded inside encodeShareTargetForHash.
    setHash(encodeShareTargetForHash(kind, evt.doc, kind === 'doc' ? evt.branch : undefined));
    const payload = deriveShareReceiveToast(evt, bridge.config.projectPath);
    if (payload !== null) {
      emitToast(payload.message, { description: payload.description, duration: 3000 });
    }
  });
}
