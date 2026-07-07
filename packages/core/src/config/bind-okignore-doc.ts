/**
 * UI-side OkignoreBinding.
 *
 * Browser-and-Node-compatible wrapper around a Hocuspocus-bound `Y.Doc` that
 * exposes a typed read/patch/subscribe API over the okignore doc's `Y.Text`.
 * Sibling to `bindConfigDoc` but text-only — the okignore body is raw
 * gitignore-syntax bytes, NOT YAML, and is NOT bound to `ConfigSchema`.
 *
 * Validation layering: this is L1 (client-side). The okignore L1 is trivially
 * satisfied (text-only, no schema). The interesting validation is L3 — the
 * server's persistence-hook rejects empty/whitespace-only lines, reverts
 * `Y.Text` to LKG via `CONFIG_VALIDATION_REVERT_ORIGIN`, and fires the
 * `config-validation-rejected` CC1 broadcast carrying an `OKIGNORE_INVALID`
 * envelope. The CC1 dispatcher in the consumer routes that broadcast back
 * through `notifyRejection()` so this binding can flip status + surface a
 * typed rejection event to its subscribers.
 *
 * Provider lifecycle: the caller owns the `HocuspocusProvider`. Each okignore
 * doc gets its OWN provider — the markdown bridge is already gated server-
 * side via `isConfigDoc()` for `__config__/okignore`, but client-side a pooled
 * provider would also engage TipTap binding (which we explicitly don't want).
 *
 * No client-side persistence: this binding does NOT call any IndexedDB
 * persistence layer. Stale IDB cache would race with fresh server LKG on
 * reconnect; cold-mount cost is well under the Settings-pane perceptual
 * tolerance.
 */

import type * as Y from 'yjs';
import type { ConfigValidationError } from './errors.ts';
import type { Err, Ok, Result } from './result.ts';

/**
 * Default Y.Text key — matches the convention used by `loadConfigDoc` /
 * `storeConfigDoc` / `applyExternalConfigChange` in
 * server/config-persistence.ts. Tests may override via options.
 */
const DEFAULT_YTEXT_KEY = 'source';

/**
 * Default acceptance window: a successful patch that doesn't draw a server
 * rejection within this window flips status from `'pending'` to `'accepted'`.
 * Sized to comfortably cover one round-trip on a local Hocuspocus server
 * + the persistence-hook validate-then-write flush; well under the
 * 300ms perceptual budget for pattern commit on a developer machine.
 */
const DEFAULT_ACCEPTANCE_DELAY_MS = 800;

/**
 * Structural type satisfied by `HocuspocusProvider` — keeps `@inkeep/open-
 * knowledge-core` free of a runtime `@hocuspocus/provider` dep. The concrete
 * `HocuspocusProvider` from `@hocuspocus/provider` satisfies this shape.
 *
 * Tests can pass a minimal mock with just `document` + a small event emitter.
 */
export interface OkignoreDocProvider {
  /** The Y.Doc bound to this provider. */
  document: Y.Doc;
  on(event: 'synced', listener: () => void): void;
  off(event: 'synced', listener: () => void): void;
}

/** Live status of the most recent commit attempt — pending until we hear back. */
export type OkignoreBindingStatus = 'idle' | 'pending' | 'accepted' | 'rejected';

/** Successful patch — text is the raw bytes that landed in `Y.Text`. */
export interface OkignoreBindingPatchSuccess {
  text: string;
}

export type OkignoreBindingPatchResult = Result<OkignoreBindingPatchSuccess, ConfigValidationError>;

/**
 * Surface payload for a server-side rejection. `text` is the post-revert
 * `Y.Text` content (the LKG that the server reapplied) so consumers don't
 * need to call `current()` separately when rendering the revert.
 */
export interface OkignoreBindingRejection {
  error: ConfigValidationError;
  text: string;
}

/** Returned from `subscribe*()` — call to stop receiving updates. */
export type OkignoreUnsubscribe = () => void;

/** Typed read/patch/subscribe API over the okignore Y.Doc. */
export interface OkignoreBinding {
  /**
   * Return the raw `Y.Text` body as a string. Never throws. The body is
   * gitignore-syntax bytes — comments, blank lines, and unparseable
   * patterns are returned verbatim (no normalisation, no parsing).
   */
  current(): string;
  /**
   * Replace the `Y.Text` body with `newText` in one transaction. The
   * mutation runs without a marked origin so it propagates through
   * Hocuspocus normally and triggers the persistence-hook (L3) for the
   * end-to-end disk write + LKG-revert flow.
   *
   * Returns `Result.err({code: 'WRITE_ERROR'})` only if the binding has
   * been disposed. Server-side rejection (empty/whitespace-only line)
   * surfaces async via `notifyRejection()` → `subscribeRejection()`.
   *
   * Side-effect: status flips to `'pending'` and an acceptance timer
   * starts; expiring without a `notifyRejection()` flips status to
   * `'accepted'`.
   */
  patch(newText: string): OkignoreBindingPatchResult;
  /**
   * Listen for changes to the bound text. Fires on every Y.Text change
   * (local + remote, including server-side L3 reverts) AND on every
   * provider `'synced'` event (reconnect-fresh-value semantic). Returns
   * an unsubscribe function.
   *
   * The listener does NOT fire synchronously on subscribe — call
   * `current()` for the initial value, then react to subsequent updates.
   */
  subscribe(listener: (text: string) => void): OkignoreUnsubscribe;
  /**
   * Listen for typed server-side rejections. Fires once per
   * `notifyRejection()` call with the error envelope and the post-revert
   * `Y.Text` content. Consumers render via `humanFormat(error)`.
   */
  subscribeRejection(listener: (rejection: OkignoreBindingRejection) => void): OkignoreUnsubscribe;
  /**
   * Listen for status transitions. Fires on every change, including the
   * acceptance-timer flip and `notifyRejection()`-driven flips. Does NOT
   * fire synchronously on subscribe — call `status()` for the current
   * value.
   */
  subscribeStatus(listener: (status: OkignoreBindingStatus) => void): OkignoreUnsubscribe;
  /** Current commit-attempt status. Starts at `'idle'` before the first patch. */
  status(): OkignoreBindingStatus;
  /**
   * CC1 dispatcher hook — the consumer's `config-validation-rejected`
   * subscriber routes payloads with `docName === '__config__/okignore'`
   * here. Cancels the in-flight acceptance timer, flips status to
   * `'rejected'`, and fires registered `subscribeRejection` listeners
   * with the post-revert text.
   *
   * Trust contract: the binding does NOT validate the docName — the
   * caller is responsible for routing only `__config__/okignore`
   * rejections to this binding instance. Mis-routed YAML rejections
   * would produce a noisy red flash on the okignore UI.
   */
  notifyRejection(error: ConfigValidationError): void;
  /**
   * Detach the binding's Y.Text observer + provider listener and
   * cancel the acceptance timer. The caller still owns the provider —
   * destroying the provider also tears down the underlying Y.Doc, which
   * would invalidate this binding even if `dispose()` was never called.
   */
  dispose(): void;
}

/** Options for `bindOkignoreDoc`. All fields optional. */
export interface BindOkignoreDocOptions {
  /** Override the Y.Text key. Defaults to `'source'`. */
  ytextKey?: string;
  /**
   * Override the acceptance-window length in milliseconds. Defaults to
   * `DEFAULT_ACCEPTANCE_DELAY_MS`. Set lower in tests to avoid timer
   * flakiness; never set to 0 (status would skip `'pending'` entirely).
   */
  acceptanceDelayMs?: number;
}

function err(error: ConfigValidationError): Err<ConfigValidationError> {
  return { ok: false, error };
}

function ok(value: OkignoreBindingPatchSuccess): Ok<OkignoreBindingPatchSuccess> {
  return { ok: true, ...value };
}

/**
 * Bind a Hocuspocus-attached Y.Doc as a typed okignore source. The caller is
 * responsible for creating + destroying the provider; the binding does NOT
 * instantiate any client-side persistence layer.
 */
export function bindOkignoreDoc(
  provider: OkignoreDocProvider,
  options: BindOkignoreDocOptions = {},
): OkignoreBinding {
  const { ytextKey = DEFAULT_YTEXT_KEY, acceptanceDelayMs = DEFAULT_ACCEPTANCE_DELAY_MS } = options;
  const ydoc = provider.document;
  const ytext = ydoc.getText(ytextKey);

  const textListeners = new Set<(text: string) => void>();
  const rejectionListeners = new Set<(rejection: OkignoreBindingRejection) => void>();
  const statusListeners = new Set<(status: OkignoreBindingStatus) => void>();
  let disposed = false;
  let currentStatus: OkignoreBindingStatus = 'idle';
  let acceptanceTimer: ReturnType<typeof setTimeout> | null = null;

  function clearAcceptanceTimer(): void {
    if (acceptanceTimer !== null) {
      clearTimeout(acceptanceTimer);
      acceptanceTimer = null;
    }
  }

  function setStatus(next: OkignoreBindingStatus): void {
    if (disposed) return;
    if (currentStatus === next) return;
    currentStatus = next;
    for (const listener of statusListeners) {
      try {
        listener(next);
      } catch (e) {
        console.warn('[bindOkignoreDoc] status listener threw:', e);
      }
    }
  }

  function fireTextListeners(): void {
    if (disposed) return;
    const text = ytext.toString();
    for (const listener of textListeners) {
      try {
        listener(text);
      } catch (e) {
        console.warn('[bindOkignoreDoc] text listener threw:', e);
      }
    }
  }

  function fireRejectionListeners(rejection: OkignoreBindingRejection): void {
    if (disposed) return;
    for (const listener of rejectionListeners) {
      try {
        listener(rejection);
      } catch (e) {
        console.warn('[bindOkignoreDoc] rejection listener threw:', e);
      }
    }
  }

  ytext.observe(fireTextListeners);
  // Provider 'synced' fires after every successful sync. When the post-sync
  // state is identical to the pre-sync state, the Y.Text observer doesn't
  // fire — but subscribers expect at least one notification on reconnect
  // with the fresh value. Wiring 'synced' to `fireTextListeners` covers
  // both cases.
  provider.on('synced', fireTextListeners);

  return {
    current(): string {
      return ytext.toString();
    },

    patch(newText: string): OkignoreBindingPatchResult {
      if (disposed) {
        return err({
          code: 'WRITE_ERROR',
          detail: 'OkignoreBinding has been disposed',
        });
      }
      ydoc.transact(() => {
        if (ytext.length > 0) ytext.delete(0, ytext.length);
        if (newText.length > 0) ytext.insert(0, newText);
      });
      // Restart the status state machine on every patch. The Y.Text
      // observer fires synchronously inside `transact` and notifies text
      // listeners BEFORE this status transition runs — that ordering is
      // intentional, the consumer can render the optimistic UI from the
      // text update and the badge from the subsequent status flip.
      clearAcceptanceTimer();
      setStatus('pending');
      acceptanceTimer = setTimeout(() => {
        acceptanceTimer = null;
        if (disposed) return;
        if (currentStatus === 'pending') setStatus('accepted');
      }, acceptanceDelayMs);
      return ok({ text: newText });
    },

    subscribe(listener: (text: string) => void): OkignoreUnsubscribe {
      textListeners.add(listener);
      return () => {
        textListeners.delete(listener);
      };
    },

    subscribeRejection(
      listener: (rejection: OkignoreBindingRejection) => void,
    ): OkignoreUnsubscribe {
      rejectionListeners.add(listener);
      return () => {
        rejectionListeners.delete(listener);
      };
    },

    subscribeStatus(listener: (status: OkignoreBindingStatus) => void): OkignoreUnsubscribe {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },

    status(): OkignoreBindingStatus {
      return currentStatus;
    },

    notifyRejection(error: ConfigValidationError): void {
      if (disposed) return;
      clearAcceptanceTimer();
      setStatus('rejected');
      fireRejectionListeners({ error, text: ytext.toString() });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearAcceptanceTimer();
      ytext.unobserve(fireTextListeners);
      provider.off('synced', fireTextListeners);
      textListeners.clear();
      rejectionListeners.clear();
      statusListeners.clear();
    },
  };
}
