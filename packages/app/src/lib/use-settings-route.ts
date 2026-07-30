/**
 * Hash-based routing for the Settings dialog.
 *
 * Two recognized hash forms: `#settings` → dialog open on its default section;
 * `#settings/<section-id>` → dialog open with that sidebar section active (an
 * entry-point deep link, e.g. the launcher dropdowns' "Settings" row opening
 * `#settings/configure-agents`). The `<section-id>` matches a sidebar item id
 * in `SettingsDialogShell`; an unknown id falls back to the default section.
 *
 * The earlier per-scope sub-routes (`#settings/project`, `#settings/user`)
 * went away when the scope toggle was removed; sidebar group membership
 * communicates scope now. The section sub-route below encodes the target
 * sidebar item, not a scope.
 *
 * Closing the dialog navigates back via `history.back()` so the prior
 * doc hash is restored when settings was opened from a doc view. If the
 * prior history entry isn't part of this session (deep link),
 * `history.back()` exits the SPA — accepted trade-off; users can
 * press Forward to return.
 *
 * Sibling pattern to `NavigationHandler` and `InstallInClaudeDesktopTrigger`
 * in `App.tsx`: hash IS the route state; entry points (Cmd-,, Electron menu,
 * header `<SettingsButton>`, CommandPalette) mutate the hash; this hook
 * reads it.
 */

import { startTransition, useEffect, useState } from 'react';
import {
  isEditableShortcutTarget,
  matchesKeyboardShortcut,
  type ShortcutEventLike,
} from '@/lib/keyboard-shortcuts';

/**
 * Canonical hash literal for opening Settings via an entry point.
 * Mirrors the `INSTALL_DIALOG_HASH = '#install-claude-desktop'` precedent in
 * App.tsx — entry points (Cmd-,, Electron menu, header `<SettingsButton>`,
 * CommandPalette) all funnel through this single literal.
 */
export const SETTINGS_OPEN_HASH = '#settings';

/** Hash that opens Settings directly to a sidebar section (deep link). */
function settingsSectionHash(sectionId: string): string {
  return `#settings/${sectionId}`;
}

/**
 * In-dialog section navigation, dispatched alongside the hash write below.
 *
 * The hash alone cannot carry this. Sidebar clicks move the dialog's `activeId`
 * WITHOUT touching the hash (deliberate — the hash is an entry point, not a
 * durable route), so the two diverge; a navigation request whose target equals
 * the current hash then writes nothing, and even an unconditional write of an
 * identical value fires no `hashchange`. The result is a dead affordance on
 * second use. This event re-fires regardless of value, the same problem the
 * shell's `ruleQuery` nonce solves for repeat rule navigation.
 */
const SECTION_INTENT_EVENT = 'open-knowledge:settings-section-intent';

/** Subscribe to in-dialog section navigation. Returns an unsubscribe. */
export function subscribeToSettingsSection(onSection: (sectionId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<string>;
    if (typeof detail === 'string' && detail.length > 0) onSection(detail);
  };
  window.addEventListener(SECTION_INTENT_EVENT, handler);
  return () => window.removeEventListener(SECTION_INTENT_EVENT, handler);
}

/**
 * Navigate to a sidebar section, whether Settings is closed or already open.
 *
 * Closed: assigning the hash pushes a history entry and opens the dialog there.
 * Open: `replaceState` keeps the URL truthful WITHOUT pushing — the dialog's
 * `close()` is a single `history.back()`, so an extra entry would make the
 * first Escape rewind to `#settings` (dialog stays open, panel snaps back to
 * Preferences) instead of closing. The event is what actually moves the panel.
 *
 * The named wrappers below are the call-site vocabulary; keep new deep links as
 * wrappers here rather than hand-building the hash at the call site.
 */
function openSettingsSection(sectionId: string): void {
  if (typeof window === 'undefined') return;
  const target = settingsSectionHash(sectionId);
  if (isSettingsHashOpen(window.location.hash)) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new CustomEvent(SECTION_INTENT_EVENT, { detail: sectionId }));
    return;
  }
  if (window.location.hash !== target) window.location.hash = target;
}

/** Sidebar item id for the User → Configure agents section. */
const CONFIGURE_AGENTS_SECTION = 'configure-agents';

/**
 * Open Settings straight to Configure agents — the "Settings" row every agent
 * launcher dropdown funnels through so the deep-link literal is single-sourced
 * (mirrors `SETTINGS_OPEN_HASH` usage in `SettingsButton`).
 */
export function openAgentSettings(): void {
  openSettingsSection(CONFIGURE_AGENTS_SECTION);
}

/** Sidebar item id for the This project → Plugins manage section. */
const PROJECT_PLUGINS_SECTION = 'plugins-manage';

/**
 * Open Settings straight to This project → Plugins — the Problems panel's
 * "enable plugins" pointer funnels through here so the deep-link literal is
 * single-sourced (mirrors `openAgentSettings`).
 */
export function openProjectPluginsSettings(): void {
  openSettingsSection(PROJECT_PLUGINS_SECTION);
}

/**
 * Sidebar item id for one plugin's own settings panel — the `plugin:<id>` ids
 * the Plugins group builds and `SettingsDialogBody` dispatches on. Mirrors
 * those two sites; a rename has to move all three together.
 */
export function pluginSettingsSectionId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * Open Settings straight to an enabled plugin's own panel — where the
 * just-enabled plugin is actually configured. The enable gesture happens on a
 * different page (the per-scope Plugins manage list), so without this the
 * plugin appears to turn on and do nothing.
 */
export function openPluginSettings(pluginId: string): void {
  openSettingsSection(pluginSettingsSectionId(pluginId));
}

interface SettingsRouteState {
  /** True when the dialog is open (hash is `#settings` or `#settings/<id>`). */
  open: boolean;
  /** Target sidebar section id from `#settings/<id>`, or null for the default. */
  section: string | null;
  /** Close the dialog via `history.back()`. No-op when already closed. */
  close: () => void;
}

/**
 * Cmd-, (macOS) / Ctrl-, (Windows/Linux) — the standard "open Settings" gesture.
 *
 * Suppresses on text inputs / textareas / contenteditable surfaces so a stray
 * Cmd-held-while-typing-comma in a number field doesn't hijack focus to the
 * Settings dialog. The Electron menu accelerator (set in `desktop/menu.ts`)
 * captures Cmd-, at the OS level for the Electron app and is independent of
 * this predicate; this predicate is the BROWSER-mode fallback. Same shape as
 * `isNewItemShortcut` in NewItemDialog.tsx.
 */
export function isSettingsShortcut(e: ShortcutEventLike): boolean {
  if (isEditableShortcutTarget(e.target)) return false;
  return matchesKeyboardShortcut(e, 'settings');
}

export function isSettingsHashOpen(hash: string): boolean {
  const cleaned = hash.replace(/^#/, '');
  if (cleaned === 'settings') return true;
  // `#settings/<section>` opens to that section; require a non-empty section so
  // a bare `#settings/` does not count as open.
  return cleaned.startsWith('settings/') && cleaned.length > 'settings/'.length;
}

/** The sidebar section id encoded in `#settings/<id>`, or null for `#settings`. */
export function settingsHashSection(hash: string): string | null {
  const cleaned = hash.replace(/^#/, '');
  if (!cleaned.startsWith('settings/')) return null;
  const section = cleaned.slice('settings/'.length);
  return section.length > 0 ? section : null;
}

function readCurrentHash(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hash;
}

export function useSettingsRoute(): SettingsRouteState {
  const [open, setOpen] = useState<boolean>(() => isSettingsHashOpen(readCurrentHash()));
  const [section, setSection] = useState<string | null>(() =>
    settingsHashSection(readCurrentHash()),
  );

  useEffect(() => {
    const onHashChange = () => {
      // Wrap the open-state flip in a transition so a warm reopen — when
      // the lazy SettingsDialogBody chunk is already cached — commits the
      // resolved tree directly. Without the transition, React re-renders
      // the shell with `open=true` urgently and the lazy reference's
      // microtask resolution can flash the body's Suspense fallback for
      // one frame even when the chunk is fully loaded. The transition
      // tells React to keep the prior (closed) tree on screen while the
      // new tree resolves and only then commit — cached body chunks
      // resolve in the same task, so the dialog opens with content and
      // no skeleton flash. Cold opens still see the fallback (the chunk
      // genuinely needs to fetch); the dialog shell paints synchronously
      // in either case because it lives in the main bundle.
      startTransition(() => {
        const hash = readCurrentHash();
        setOpen(isSettingsHashOpen(hash));
        setSection(settingsHashSection(hash));
      });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const close = () => {
    if (typeof window === 'undefined') return;
    if (!isSettingsHashOpen(readCurrentHash())) return;
    window.history.back();
  };

  return { open, section, close };
}
