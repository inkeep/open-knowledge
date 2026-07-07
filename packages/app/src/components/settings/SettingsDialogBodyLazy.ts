/**
 * Shared lazy reference for the Settings dialog body chunk.
 *
 * Two consumers, one chunk:
 *   - `SettingsDialogShell` renders `<SettingsDialogBodyLazy>` inside
 *     a Suspense boundary. The body chunk fetch fires on first
 *     render of the lazy element (i.e. the first time the dialog
 *     opens).
 *   - `SettingsButton` calls `SettingsDialogBodyLazy.preload()` on
 *     hover/focus intent (debounced ~50ms). When the user then
 *     opens Settings, the chunk is already in-flight or resolved,
 *     removing the network round-trip from the cold-open path. The
 *     cold open still shows a brief content skeleton (gated by the
 *     body subtree's first-render, not the chunk fetch); only a warm
 *     reopen is skeleton-free. See `SettingsButton`'s prefetch
 *     docstring for the full rationale.
 *
 * The reference lives in its own module (not inside Shell) so the
 * header button can warm the chunk without importing Shell. Both
 * sites point at the same memoized factory inside
 * `lazyWithPreload`, so the import fires at most once per session.
 *
 * `import('./SettingsDialogBody')` is the only static reference to
 * the body file — Vite's chunk graph splits it off into a separate
 * chunk so the heavy form harness, RHF, ConfigSchema, schema-walker,
 * and Sync/Templates/Okignore/Integrations sections don't bloat the
 * main bundle.
 */

import { lazyWithPreload } from '@/lib/lazy-with-preload';

export const SettingsDialogBodyLazy = lazyWithPreload(() =>
  import('./SettingsDialogBody').then((m) => ({ default: m.SettingsDialogBody })),
);
