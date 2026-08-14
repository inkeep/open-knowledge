/**
 * Note-window mode — is this renderer a popped-out single-document window
 * (`--ok-mode=note`)? When true the App drops workspace chrome (file sidebar,
 * tab strip, command palette, doc panel, agent panel, docked terminal) and
 * renders one document full-window, keeping the editor, its toolbar, the
 * property panel, the footer, and the connecting banner.
 *
 * Single-channel, unlike `useSingleFileMode`'s dual-channel resolution. The
 * flag rides `window.okDesktop.config.mode`, which is a frozen argv-derived
 * snapshot resolved before first render, so this answers synchronously and
 * there is no chrome flash and no `/api/config` fallback to write. The web host
 * cannot reach note mode at all: it has no desktop bridge, so this is always
 * false there.
 */

// Loads the `Window.okDesktop?` global augmentation (side-effect import).
import '@/lib/desktop-bridge-types';

/**
 * `true` when this window is a popped-out single-document note window.
 *
 * `config` is optional-chained even though the bridge type declares it
 * required: partial bridges are real at runtime. Session-only E2E hosts expose
 * a bridge without the full surface, and this is read during render, so a throw
 * here takes the whole header down rather than degrading.
 */
export function isNoteWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return window.okDesktop?.config?.mode === 'note';
}
