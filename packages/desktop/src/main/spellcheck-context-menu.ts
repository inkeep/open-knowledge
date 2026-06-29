import type {
  BuildSpellcheckMenuTemplateParams,
  SpellcheckMenuActions,
  SpellcheckMenuParams,
} from './spellcheck-menu.ts';

export interface ContextMenuHandlerParams extends SpellcheckMenuParams {
  readonly isEditable: boolean;
}

export interface SpellcheckWebContents {
  on(
    event: 'context-menu',
    listener: (event: unknown, params: ContextMenuHandlerParams) => void,
  ): void;
  replaceMisspelling(text: string): void;
  showDefinitionForSelection(): void;
}

export interface SpellcheckContextMenuDeps {
  readonly isSpellCheckEnabled: () => boolean;
  readonly setSpellCheckEnabled: (enabled: boolean) => void;
  readonly addToDictionary: (word: string) => void;
  readonly openExternal: (url: string) => void;
  readonly popMenu: (input: BuildSpellcheckMenuTemplateParams) => void;
}

function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export function attachSpellcheckContextMenu(
  webContents: SpellcheckWebContents,
  deps: SpellcheckContextMenuDeps,
): void {
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const actions: SpellcheckMenuActions = {
      replaceMisspelling: (suggestion) => {
        webContents.replaceMisspelling(suggestion);
      },
      addToDictionary: (word) => {
        deps.addToDictionary(word);
      },
      setSpellCheckEnabled: (enabled) => {
        deps.setSpellCheckEnabled(enabled);
      },
      lookUp: () => {
        webContents.showDefinitionForSelection();
      },
      search: (query) => {
        deps.openExternal(googleSearchUrl(query));
      },
    };
    deps.popMenu({
      params,
      spellCheckEnabled: deps.isSpellCheckEnabled(),
      actions,
    });
  });
}
