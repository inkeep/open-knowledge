/**
 * Seed the initial-doc hash for an ephemeral single-file window (`ok <file>`).
 *
 * The desktop bridge injects the doc to open as `config.initialDoc` (the
 * `--ok-initial-doc` argv flag → preload). At renderer startup — BEFORE
 * `createRoot().render()` — we write it into `window.location.hash` so
 * `NavigationHandler`'s first-mount read resolves the doc on its own, with no
 * post-load IPC in the loop.
 *
 * This replaces a `dom-ready`-gated `ok:deep-link` send for this path. That IPC
 * is subscribed to lazily in the renderer (`installDeepLinkListener` →
 * `ipcRenderer.on`, only once `main.tsx` runs) with no preload-side buffer, so a
 * send that beat the registration dropped — and the ephemeral window starts from
 * a fresh temp dir with no session/tab restore, so a drop fell straight through
 * to the empty-state ("Create something great") splash. The hash is the
 * documented navigation source of truth; seeding it is deterministic because it
 * is set synchronously before any React effect can read it.
 */

import { hashFromDocName } from '@/lib/doc-hash';

interface SeedInitialDocHashOptions {
  /** `window.okDesktop?.config.initialDoc` — the doc to open, or null/absent. */
  readonly initialDoc: string | null | undefined;
  /** Read the current location hash. Production: `() => window.location.hash`. */
  readonly getHash: () => string;
  /** Write the location hash. Production: `(h) => { window.location.hash = h; }`. */
  readonly setHash: (hash: string) => void;
}

/**
 * Write `#/<initialDoc>` into the hash when one is configured and the hash is
 * still at base. No-op when there is no `initialDoc` (every non-ephemeral
 * window) or when the hash already carries a target — a cold ephemeral window
 * always starts empty, so the base-hash guard only matters as defense against
 * clobbering a hash a faster path already set.
 */
export function seedInitialDocHash(opts: SeedInitialDocHashOptions): void {
  const { initialDoc } = opts;
  if (!initialDoc) return;
  const hash = opts.getHash();
  if (hash !== '' && hash !== '#' && hash !== '#/') return;
  opts.setHash(hashFromDocName(initialDoc));
}

/**
 * The `main.tsx` wiring: read the doc from the desktop bridge config and seed
 * the live `window.location.hash`. No-op in web/CLI (no `window.okDesktop`) and
 * on every non-ephemeral window (`initialDoc` null). Call once at renderer
 * startup, BEFORE `createRoot().render()`. Extracted from `main.tsx` (which is
 * not unit-testable — it boots the whole app) so the window→hash wiring is
 * driven by a real DOM.
 */
export function seedInitialDocHashFromWindow(): void {
  if (typeof window === 'undefined' || !window.okDesktop) return;
  seedInitialDocHash({
    initialDoc: window.okDesktop.config.initialDoc,
    getHash: () => window.location.hash,
    setHash: (hash) => {
      window.location.hash = hash;
    },
  });
}
