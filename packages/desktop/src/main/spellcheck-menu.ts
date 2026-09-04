import { NATIVE_MENU_LABELS } from '@inkeep/open-knowledge-core';
import type { BrowserWindow, EditFlags, Menu, MenuItemConstructorOptions } from 'electron';
import { type MenuTranslator, translateEnglish } from './menu-translator.ts';

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
  readonly viewInSource: () => void;
}

export interface BuildSpellcheckMenuTemplateParams {
  readonly params: SpellcheckMenuParams;
  readonly spellCheckEnabled: boolean;
  readonly canViewInSource: boolean;
  readonly actions: SpellcheckMenuActions;
  readonly translate?: MenuTranslator;
}

const LOOKUP_LABEL_MAX = 50;
const SEARCH_QUERY_MAX = 200;

export function buildSpellcheckMenuTemplate(
  input: BuildSpellcheckMenuTemplateParams,
): MenuItemConstructorOptions[] {
  const { params, spellCheckEnabled, canViewInSource, actions } = input;
  const { misspelledWord, dictionarySuggestions, selectionText, editFlags } = params;
  const translate = input.translate ?? translateEnglish;

  const roleRow = (
    role: 'cut' | 'copy' | 'paste' | 'selectAll',
    source: string,
  ): MenuItemConstructorOptions => ({ role, label: translate(source) });

  const editSection: MenuItemConstructorOptions[] = [];
  if (editFlags.canCut) editSection.push(roleRow('cut', NATIVE_MENU_LABELS.roleCut));
  if (editFlags.canCopy) editSection.push(roleRow('copy', NATIVE_MENU_LABELS.roleCopy));
  if (editFlags.canPaste) editSection.push(roleRow('paste', NATIVE_MENU_LABELS.rolePaste));
  if (editFlags.canSelectAll)
    editSection.push(roleRow('selectAll', NATIVE_MENU_LABELS.roleSelectAll));

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
      label: translate(NATIVE_MENU_LABELS.addToDictionary),
      click: () => {
        actions.addToDictionary(misspelledWord);
      },
    });
    spellSection.push({
      label: translate(NATIVE_MENU_LABELS.disableSpellCheck),
      click: () => {
        actions.setSpellCheckEnabled(false);
      },
    });
  } else if (!spellCheckEnabled) {
    spellSection.push({
      label: translate(NATIVE_MENU_LABELS.enableSpellCheck),
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
      label: translate(NATIVE_MENU_LABELS.lookUpWord, { word: labelWord }),
      click: () => {
        actions.lookUp();
      },
    });
    lookupSection.push({
      label: translate(NATIVE_MENU_LABELS.searchWithGoogle),
      click: () => {
        actions.search(query);
      },
    });
  }

  const viewSection: MenuItemConstructorOptions[] = canViewInSource
    ? [
        {
          label: translate(NATIVE_MENU_LABELS.viewInSourceMarkdown),
          click: () => {
            actions.viewInSource();
          },
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [];
  for (const section of [editSection, spellSection, lookupSection, viewSection]) {
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
