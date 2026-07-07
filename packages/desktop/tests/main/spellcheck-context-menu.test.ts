/**
 * Unit tests for the editor context-menu attach helper. Drives the registered
 * `context-menu` listener with fake params and asserts the isEditable gate, the
 * freshly-read spell-check flag, and that each assembled menu action routes to
 * the right injected capability — all without mounting a BrowserWindow.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  attachSpellcheckContextMenu,
  type ContextMenuHandlerParams,
} from '../../src/main/spellcheck-context-menu.ts';
import type { BuildSpellcheckMenuTemplateParams } from '../../src/main/spellcheck-menu.ts';

const allEditFlags = {
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
} as const;

function makeParams(overrides: Partial<ContextMenuHandlerParams> = {}): ContextMenuHandlerParams {
  return {
    isEditable: true,
    misspelledWord: '',
    dictionarySuggestions: [],
    selectionText: '',
    editFlags: allEditFlags,
    ...overrides,
  };
}

function makeWebContents() {
  let handler: ((event: unknown, params: ContextMenuHandlerParams) => void) | undefined;
  return {
    on: mock(
      (
        _event: 'context-menu',
        listener: (event: unknown, params: ContextMenuHandlerParams) => void,
      ) => {
        handler = listener;
      },
    ),
    replaceMisspelling: mock((_: string) => {}),
    showDefinitionForSelection: mock(() => {}),
    /** Fire a context-menu event at the registered handler. */
    fire(params: ContextMenuHandlerParams) {
      if (!handler) throw new Error('no context-menu handler registered');
      handler({}, params);
    },
  };
}

function makeDeps(isSpellCheckEnabled: () => boolean = () => true) {
  return {
    isSpellCheckEnabled,
    setSpellCheckEnabled: mock((_: boolean) => {}),
    addToDictionary: mock((_: string) => {}),
    openExternal: mock((_: string) => {}),
    popMenu: mock((_: BuildSpellcheckMenuTemplateParams) => {}),
  };
}

describe('attachSpellcheckContextMenu — isEditable gate', () => {
  test('non-editable target pops no menu', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    attachSpellcheckContextMenu(wc, deps);
    wc.fire(makeParams({ isEditable: false }));
    expect(deps.popMenu).not.toHaveBeenCalled();
  });

  test('editable target pops the menu once', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    attachSpellcheckContextMenu(wc, deps);
    wc.fire(makeParams({ isEditable: true }));
    expect(deps.popMenu).toHaveBeenCalledTimes(1);
  });
});

describe('attachSpellcheckContextMenu — spellCheckEnabled flag', () => {
  test('reads the flag fresh on each right-click', () => {
    const wc = makeWebContents();
    const values = [true, false];
    const deps = makeDeps(() => values.shift() ?? true);
    attachSpellcheckContextMenu(wc, deps);
    wc.fire(makeParams());
    wc.fire(makeParams());
    const firstInput = deps.popMenu.mock.calls[0]?.[0];
    const secondInput = deps.popMenu.mock.calls[1]?.[0];
    expect(firstInput?.spellCheckEnabled).toBe(true);
    expect(secondInput?.spellCheckEnabled).toBe(false);
  });
});

describe('attachSpellcheckContextMenu — params forwarding', () => {
  test('popMenu receives the fired params object', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    attachSpellcheckContextMenu(wc, deps);
    const fired = makeParams({ misspelledWord: 'teh', selectionText: 'teh fox' });
    wc.fire(fired);
    expect(deps.popMenu.mock.calls[0]?.[0]?.params).toBe(fired);
  });
});

describe('attachSpellcheckContextMenu — action wiring', () => {
  function fireAndGetActions(
    wc: ReturnType<typeof makeWebContents>,
    deps: ReturnType<typeof makeDeps>,
    params: ContextMenuHandlerParams,
  ): BuildSpellcheckMenuTemplateParams['actions'] {
    attachSpellcheckContextMenu(wc, deps);
    wc.fire(params);
    const input = deps.popMenu.mock.calls[0]?.[0];
    if (!input) throw new Error('popMenu was not called');
    return input.actions;
  }

  test('replaceMisspelling routes to webContents.replaceMisspelling', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    const actions = fireAndGetActions(wc, deps, makeParams({ misspelledWord: 'teh' }));
    actions.replaceMisspelling('the');
    expect(wc.replaceMisspelling).toHaveBeenCalledWith('the');
  });

  test('addToDictionary routes to the injected capability', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    const actions = fireAndGetActions(wc, deps, makeParams({ misspelledWord: 'teh' }));
    actions.addToDictionary('teh');
    expect(deps.addToDictionary).toHaveBeenCalledWith('teh');
  });

  test('setSpellCheckEnabled routes to the injected capability', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    const actions = fireAndGetActions(wc, deps, makeParams({ misspelledWord: 'teh' }));
    actions.setSpellCheckEnabled(false);
    expect(deps.setSpellCheckEnabled).toHaveBeenCalledWith(false);
  });

  test('lookUp routes to webContents.showDefinitionForSelection', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    const actions = fireAndGetActions(wc, deps, makeParams({ selectionText: 'flow' }));
    actions.lookUp();
    expect(wc.showDefinitionForSelection).toHaveBeenCalledTimes(1);
  });

  test('search opens a Google query URL for the word', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    const actions = fireAndGetActions(wc, deps, makeParams({ selectionText: 'flow' }));
    actions.search('flow');
    expect(deps.openExternal).toHaveBeenCalledWith('https://www.google.com/search?q=flow');
  });

  test('search percent-encodes the query', () => {
    const wc = makeWebContents();
    const deps = makeDeps();
    const actions = fireAndGetActions(wc, deps, makeParams({ selectionText: 'a b&c' }));
    actions.search('a b&c');
    expect(deps.openExternal).toHaveBeenCalledWith('https://www.google.com/search?q=a%20b%26c');
  });
});
