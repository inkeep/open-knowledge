/**
 * User-facing string constants surfaced from the desktop app's main process.
 *
 * Inclusion rule: native-OS menu items consumed only by `main/menu.ts`. Other
 * surfaces (renderer dropdowns, command palette, CLI) inline their literals.
 *
 * Keep this file zero-dep — it loads in main, preload, and any test runner.
 */

/**
 * macOS / Windows / Linux native menu bar item for re-summoning the Project
 * Navigator (`File → Switch project…`, accelerator `Cmd+Shift+N`). Consumed
 * only by `packages/desktop/src/main/menu.ts`.
 *
 * The trailing `…` is the native-menu convention for "opens a new surface"
 * (Apple HIG / Windows HIG / GTK). Renderer-side surfaces (ProjectSwitcher
 * dropdown, CommandPalette row) render the bare `Switch project` label —
 * `…` is reserved for native menus and truncation indicators only.
 */
export const SWITCH_PROJECT_LABEL_WITH_ELLIPSIS = 'Switch project…' as const;
