/**
 * Native right-click context menu for editable content in the desktop editor.
 * Built from `Menu.buildFromTemplate` in main — main observes the webContents
 * `context-menu` event directly, so spellcheck params and clipboard edit flags
 * are read without any IPC gesture forwarding.
 *
 * Section layout (empty sections and their separators are omitted, so the
 * builder returns only applicable rows):
 *   - Edit roles: Cut / Copy / Paste / Select All, each shown per the matching
 *     `editFlags` capability (built-in Electron menu roles, zero custom logic).
 *   - Spellcheck: shown only when a word is flagged AND checking is on — one
 *     row per dictionary suggestion, then Add to Dictionary, then Disable
 *     Spell Check. When checking is off, a single Enable Spell Check row
 *     replaces the whole block. In practice Chromium stops populating
 *     `misspelledWord` while checking is off, so the two states are expected
 *     to be mutually exclusive — but that is observed runtime behavior, not a
 *     guarantee (`spellCheckEnabled` is OK's persisted flag, a separate source
 *     that can race a toggle), so the branches handle a stale flagged word
 *     with checking off defensively (Enable row, no suggestions).
 *   - Look Up / Search with Google: shown when there is a selection or a
 *     flagged word to act on.
 *
 * Pure: `buildSpellcheckMenuTemplate` takes a params slice + the current
 * `spellCheckEnabled` flag + an `actions` object and returns a
 * `MenuItemConstructorOptions[]`. Actions are injected as callbacks so the
 * builder stays Electron-free and unit-testable — tests exercise template shape
 * plus callback dispatch without mounting Electron's Menu.
 */

import type { BrowserWindow, EditFlags, Menu, MenuItemConstructorOptions } from 'electron';

/**
 * The slice of Electron's `ContextMenuParams` the builder reads. Declared as a
 * structural subset so the real event params assign directly at the call site;
 * a renamed Electron field surfaces as a compile error there.
 */
export interface SpellcheckMenuParams {
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
  readonly selectionText: string;
  readonly editFlags: Readonly<Pick<EditFlags, 'canCut' | 'canCopy' | 'canPaste' | 'canSelectAll'>>;
}

export interface SpellcheckMenuActions {
  /** Replace the flagged word with the chosen correction. */
  readonly replaceMisspelling: (suggestion: string) => void;
  /** Teach the OS dictionary the flagged word. */
  readonly addToDictionary: (word: string) => void;
  /** Toggle app-wide spell checking and persist the new value. */
  readonly setSpellCheckEnabled: (enabled: boolean) => void;
  /** Show the macOS definition panel for the current selection. */
  readonly lookUp: () => void;
  /** Open a web search for the selection or flagged word. */
  readonly search: (query: string) => void;
}

export interface BuildSpellcheckMenuTemplateParams {
  readonly params: SpellcheckMenuParams;
  /** Whether spell checking is currently on (the persisted app-wide flag). */
  readonly spellCheckEnabled: boolean;
  readonly actions: SpellcheckMenuActions;
}

/**
 * Caps on user text embedded in the Look Up label / search query. A selection
 * is unbounded — without a cap a select-all right-click produces a
 * screen-wide menu row and a search URL long enough for Google to reject.
 * Prior art: `electron-context-menu` truncates its Look Up label the same way.
 *
 * `slice` cuts at UTF-16 code-unit boundaries, so a cap landing mid-surrogate
 * pair (emoji, astral CJK) leaves a trailing lone surrogate —
 * `encodeURIComponent` throws `URIError` on those at the search-URL sink.
 * `toWellFormed()` after each slice replaces any lone surrogate with U+FFFD.
 */
const LOOKUP_LABEL_MAX = 50;
const SEARCH_QUERY_MAX = 200;

export function buildSpellcheckMenuTemplate(
  input: BuildSpellcheckMenuTemplateParams,
): MenuItemConstructorOptions[] {
  const { params, spellCheckEnabled, actions } = input;
  const { misspelledWord, dictionarySuggestions, selectionText, editFlags } = params;

  const editSection: MenuItemConstructorOptions[] = [];
  if (editFlags.canCut) editSection.push({ role: 'cut' });
  if (editFlags.canCopy) editSection.push({ role: 'copy' });
  if (editFlags.canPaste) editSection.push({ role: 'paste' });
  if (editFlags.canSelectAll) editSection.push({ role: 'selectAll' });

  const spellSection: MenuItemConstructorOptions[] = [];
  if (misspelledWord && spellCheckEnabled) {
    for (const suggestion of dictionarySuggestions) {
      spellSection.push({
        label: suggestion,
        click: () => {
          actions.replaceMisspelling(suggestion);
        },
      });
    }
    spellSection.push({
      label: 'Add to Dictionary',
      click: () => {
        actions.addToDictionary(misspelledWord);
      },
    });
    spellSection.push({
      label: 'Disable Spell Check',
      click: () => {
        actions.setSpellCheckEnabled(false);
      },
    });
  } else if (!spellCheckEnabled) {
    spellSection.push({
      label: 'Enable Spell Check',
      click: () => {
        actions.setSpellCheckEnabled(true);
      },
    });
  }

  const word = selectionText || misspelledWord;
  const lookupSection: MenuItemConstructorOptions[] = [];
  if (word) {
    const labelWord =
      word.length > LOOKUP_LABEL_MAX ? `${word.slice(0, LOOKUP_LABEL_MAX).toWellFormed()}…` : word;
    const query = word.slice(0, SEARCH_QUERY_MAX).toWellFormed();
    lookupSection.push({
      label: `Look Up "${labelWord}"`,
      click: () => {
        actions.lookUp();
      },
    });
    lookupSection.push({
      label: 'Search with Google',
      click: () => {
        actions.search(query);
      },
    });
  }

  const template: MenuItemConstructorOptions[] = [];
  for (const section of [editSection, spellSection, lookupSection]) {
    if (section.length === 0) continue;
    if (template.length > 0) template.push({ type: 'separator' });
    template.push(...section);
  }
  return template;
}

interface PopSpellcheckMenuDeps {
  /** Electron `Menu` ctor — injected for testability. */
  readonly Menu: Pick<typeof Menu, 'buildFromTemplate'>;
  /** Window to pop the menu over (the one whose webContents fired the event). */
  readonly window: BrowserWindow;
}

/**
 * Build the template + pop the native menu on the given window. Thin
 * orchestration so the pure template builder stays test-easy and the popup call
 * lives in one place.
 */
export function popSpellcheckMenu(
  deps: PopSpellcheckMenuDeps,
  params: BuildSpellcheckMenuTemplateParams,
): void {
  // A right-click can race window close (⌘W): `popup` on a destroyed window
  // pops over an arbitrary surviving window, or throws when none remain —
  // fatal in main, which deliberately has no userland uncaughtException
  // handler (see process-safety-net.ts). Dropping the menu is the right
  // outcome for a gesture on a window that no longer exists.
  if (deps.window.isDestroyed()) return;
  const template = buildSpellcheckMenuTemplate(params);
  deps.Menu.buildFromTemplate(template).popup({ window: deps.window });
}
