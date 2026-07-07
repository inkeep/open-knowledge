/**
 * Gates the in-app entry points that install the OpenKnowledge skill into a
 * Claude host (command palette item, Settings → Integrations row, App-root
 * `#install-claude-desktop` hash trigger, macOS Help menu item, and the
 * `openknowledge://screen?name=install-claude` deep link). When `false`, all
 * entry points are hidden but the underlying machinery
 * (`InstallInClaudeDesktopDialog`, `useClaudeDesktopIntegration`) stays
 * compiled so flipping this flag re-exposes the surface without further work.
 */
export const SHOW_INSTALL_SKILL = false;
