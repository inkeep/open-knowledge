
import type { BrowserWindow, EditFlags, Menu, MenuItemConstructorOptions } from 'electron';

export interface SpellcheckMenuParams {
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
  readonly selectionText: string;
  readonly editFlags: Readonly<Pick<EditFlags, 'canCut' | 'canCopy' | 'canPaste' | 'canSelectAll'>>;
}

export interface SpellcheckMenuActions {
  readonly replaceMisspelling: (suggestion: string) => void;
  readonly addToDictionary: (word: string) => void;
  readonly setSpellCheckEnabled: (enabled: boolean) => void;
  readonly lookUp: () => void;
  readonly search: (query: string) => void;
}

export interface BuildSpellcheckMenuTemplateParams {
  readonly params: SpellcheckMenuParams;
  readonly spellCheckEnabled: boolean;
  readonly actions: SpellcheckMenuActions;
}

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
  readonly Menu: Pick<typeof Menu, 'buildFromTemplate'>;
  readonly window: BrowserWindow;
}

export function popSpellcheckMenu(
  deps: PopSpellcheckMenuDeps,
  params: BuildSpellcheckMenuTemplateParams,
): void {
  if (deps.window.isDestroyed()) return;
  const template = buildSpellcheckMenuTemplate(params);
  deps.Menu.buildFromTemplate(template).popup({ window: deps.window });
}
