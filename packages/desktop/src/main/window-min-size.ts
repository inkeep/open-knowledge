/**
 * Minimum window dimensions enforced at BrowserWindow construction.
 *
 * Electron's `minWidth` / `minHeight` BrowserWindow options default to `0`
 * (https://www.electronjs.org/docs/latest/api/structures/base-window-options),
 * which lets users drag the window to ~0 px — the chrome collapses and the
 * surface becomes unusable. These constants opt into a usable floor for each
 * window class. Per-class values are calibrated to OK's UI density.
 *
 * The shape mirrors VS Code's `WindowMinimumSize` (microsoft/vscode at
 * `src/vs/platform/window/common/window.ts`). Any value can be
 * retuned later without migration impact.
 */
export const WINDOW_MIN_SIZE = {
  /**
   * Editor window — denser chrome (TipTap WYSIWYG toolbar + frontmatter
   * property panel + body). Sits above VS Code's `400 × 270` because
   * OK's editor doesn't collapse chrome as aggressively.
   */
  EDITOR: { width: 720, height: 480 },
  /**
   * Navigator window (File → Switch Project, ⌘N). The floor accommodates
   * the chrome footprint without requiring responsive-layout work: 3 cards
   * stay in a row (above Tailwind's `sm:` breakpoint at 640 px), and the
   * empty state's centered header+cards group still has room to breathe.
   * Above this size the existing NavigatorApp layout works as-designed.
   */
  NAVIGATOR: { width: 640, height: 560 },
} as const;
