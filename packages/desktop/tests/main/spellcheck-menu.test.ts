/**
 * Unit tests for the editor spellcheck context-menu template + pop dispatch.
 * Covers section composition per `ContextMenuParams` (edit roles, spellcheck
 * rows, Look Up / Search), separator omission for empty sections, and callback
 * dispatch wiring. Mirrors `asset-menu.test.ts` — template shape is exercised
 * without mounting Electron's Menu.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import {
  type BuildSpellcheckMenuTemplateParams,
  buildSpellcheckMenuTemplate,
  popSpellcheckMenu,
  type SpellcheckMenuParams,
} from '../../src/main/spellcheck-menu.ts';

function makeActions() {
  return {
    replaceMisspelling: mock((_: string) => {}),
    addToDictionary: mock((_: string) => {}),
    setSpellCheckEnabled: mock((_: boolean) => {}),
    lookUp: mock(() => {}),
    search: mock((_: string) => {}),
  };
}

const allEditFlags = {
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
} as const;

function makeParams(overrides: Partial<SpellcheckMenuParams> = {}): SpellcheckMenuParams {
  return {
    misspelledWord: '',
    dictionarySuggestions: [],
    selectionText: '',
    editFlags: allEditFlags,
    ...overrides,
  };
}

function build(
  params: SpellcheckMenuParams,
  spellCheckEnabled: boolean,
  actions: BuildSpellcheckMenuTemplateParams['actions'],
): MenuItemConstructorOptions[] {
  return buildSpellcheckMenuTemplate({ params, spellCheckEnabled, actions });
}

/** Project a template to a comparable shape: role, label, or separator marker. */
function shapeOf(template: MenuItemConstructorOptions[]): string[] {
  return template.map((e) => e.role ?? e.label ?? `[${e.type}]`);
}

describe('buildSpellcheckMenuTemplate — section composition', () => {
  test('editable text with no misspelling and no selection → edit roles only', () => {
    const template = build(makeParams(), true, makeActions());
    expect(shapeOf(template)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
  });

  test('edit roles respect editFlags', () => {
    const params = makeParams({
      editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: false },
    });
    const template = build(params, true, makeActions());
    expect(shapeOf(template)).toEqual(['copy', 'paste']);
  });

  test('flagged word with checking on → suggestions, Add to Dictionary, Disable, Look Up, Search', () => {
    const params = makeParams({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech'],
    });
    const template = build(params, true, makeActions());
    expect(shapeOf(template)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      'the',
      'tech',
      'Add to Dictionary',
      'Disable Spell Check',
      '[separator]',
      'Look Up "teh"',
      'Search with Google',
    ]);
  });

  test('flagged word with zero suggestions → Add to Dictionary + Disable, no suggestion rows', () => {
    const params = makeParams({ misspelledWord: 'zzx', dictionarySuggestions: [] });
    const template = build(params, true, makeActions());
    expect(shapeOf(template)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      'Add to Dictionary',
      'Disable Spell Check',
      '[separator]',
      'Look Up "zzx"',
      'Search with Google',
    ]);
  });

  test('checking off → Enable spell check replaces the disable block', () => {
    const template = build(makeParams(), false, makeActions());
    expect(shapeOf(template)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      'Enable Spell Check',
    ]);
  });

  test('flagged word with checking off → Enable row only, no suggestion rows', () => {
    // `spellCheckEnabled` is OK's persisted flag while `misspelledWord` comes
    // from Chromium — a toggle racing a right-click can deliver both, so this
    // pins which branch wins: the disabled state.
    const params = makeParams({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] });
    const template = build(params, false, makeActions());
    expect(shapeOf(template)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      'Enable Spell Check',
      '[separator]',
      'Look Up "teh"',
      'Search with Google',
    ]);
  });

  test('selection without a misspelling → Look Up and Search rows', () => {
    const params = makeParams({ selectionText: 'hello world' });
    const template = build(params, true, makeActions());
    expect(shapeOf(template)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      'Look Up "hello world"',
      'Search with Google',
    ]);
  });

  test('no rows at all → empty template (no dangling separators)', () => {
    const params = makeParams({
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    });
    const template = build(params, true, makeActions());
    expect(template).toHaveLength(0);
  });

  test('leading section absent → no leading separator', () => {
    const params = makeParams({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    });
    const template = build(params, true, makeActions());
    expect(template[0]?.type).not.toBe('separator');
    expect(shapeOf(template)).toEqual([
      'the',
      'Add to Dictionary',
      'Disable Spell Check',
      '[separator]',
      'Look Up "teh"',
      'Search with Google',
    ]);
  });
});

describe('buildSpellcheckMenuTemplate — callback dispatch', () => {
  function clickRow(template: MenuItemConstructorOptions[], label: string) {
    const row = template.find((e) => e.label === label);
    if (!row?.click) throw new Error(`no clickable row labelled ${label}`);
    // biome-ignore lint/suspicious/noExplicitAny: test invokes the click callback
    (row.click as any)();
  }

  test('clicking a suggestion replaces with that exact suggestion', () => {
    const actions = makeActions();
    const params = makeParams({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'] });
    const template = build(params, true, actions);
    clickRow(template, 'tech');
    expect(actions.replaceMisspelling).toHaveBeenCalledTimes(1);
    expect(actions.replaceMisspelling).toHaveBeenCalledWith('tech');
  });

  test('Add to Dictionary adds the flagged word', () => {
    const actions = makeActions();
    const params = makeParams({ misspelledWord: 'teh', dictionarySuggestions: ['the'] });
    const template = build(params, true, actions);
    clickRow(template, 'Add to Dictionary');
    expect(actions.addToDictionary).toHaveBeenCalledWith('teh');
  });

  test('Disable spell check disables checking', () => {
    const actions = makeActions();
    const params = makeParams({ misspelledWord: 'teh', dictionarySuggestions: ['the'] });
    const template = build(params, true, actions);
    clickRow(template, 'Disable Spell Check');
    expect(actions.setSpellCheckEnabled).toHaveBeenCalledWith(false);
  });

  test('Enable spell check enables checking', () => {
    const actions = makeActions();
    const template = build(makeParams(), false, actions);
    clickRow(template, 'Enable Spell Check');
    expect(actions.setSpellCheckEnabled).toHaveBeenCalledWith(true);
  });

  test('Look Up fires lookUp; Search fires search with the word', () => {
    const actions = makeActions();
    const params = makeParams({ selectionText: 'flow' });
    const template = build(params, true, actions);
    clickRow(template, 'Look Up "flow"');
    clickRow(template, 'Search with Google');
    expect(actions.lookUp).toHaveBeenCalledTimes(1);
    expect(actions.search).toHaveBeenCalledWith('flow');
  });

  test('Search falls back to the flagged word when there is no selection', () => {
    const actions = makeActions();
    const params = makeParams({ misspelledWord: 'teh', dictionarySuggestions: ['the'] });
    const template = build(params, true, actions);
    clickRow(template, 'Search with Google');
    expect(actions.search).toHaveBeenCalledWith('teh');
  });

  test('selection takes precedence over the flagged word for Look Up and Search', () => {
    const actions = makeActions();
    const params = makeParams({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      selectionText: 'teh quick fox',
    });
    const template = build(params, true, actions);
    expect(shapeOf(template)).toContain('Look Up "teh quick fox"');
    clickRow(template, 'Search with Google');
    expect(actions.search).toHaveBeenCalledWith('teh quick fox');
  });

  test('long selections are truncated in the Look Up label and capped in the search query', () => {
    const actions = makeActions();
    const template = build(makeParams({ selectionText: 'x'.repeat(500) }), true, actions);
    const lookUpRow = template.find((e) => e.label?.startsWith('Look Up'));
    expect(lookUpRow?.label).toBe(`Look Up "${'x'.repeat(50)}…"`);
    clickRow(template, 'Search with Google');
    expect(actions.search).toHaveBeenCalledWith('x'.repeat(200));
  });

  test('query truncation never splits a surrogate pair (encodeURIComponent-safe)', () => {
    const actions = makeActions();
    // 199 BMP chars + an astral emoji straddling the 200-code-unit query cap —
    // a naive slice leaves a trailing lone surrogate, which encodeURIComponent
    // rejects with URIError at the search-URL sink.
    const template = build(makeParams({ selectionText: `${'x'.repeat(199)}😀` }), true, actions);
    clickRow(template, 'Search with Google');
    const query = actions.search.mock.calls[0]?.[0] ?? '';
    expect(() => encodeURIComponent(query)).not.toThrow();
    expect(query).toBe(`${'x'.repeat(199)}�`);
  });

  test('label truncation never splits a surrogate pair', () => {
    const actions = makeActions();
    // 49 BMP chars + an astral emoji straddling the 50-code-unit label cap.
    const template = build(
      makeParams({ selectionText: `${'y'.repeat(49)}😀${'z'.repeat(10)}` }),
      true,
      actions,
    );
    const lookUpRow = template.find((e) => e.label?.startsWith('Look Up'));
    expect(lookUpRow?.label).toBe(`Look Up "${'y'.repeat(49)}�…"`);
  });
});

describe('popSpellcheckMenu', () => {
  function makeMenuFakes() {
    const popup = mock((_: unknown) => {});
    const menuInstance = { popup } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    const buildFromTemplate = mock((_: MenuItemConstructorOptions[]) => menuInstance);
    return { popup, buildFromTemplate };
  }

  test('builds the template from the given params + pops via injected Menu ctor', () => {
    const { popup, buildFromTemplate } = makeMenuFakes();
    const fakeWindow = { id: 7, isDestroyed: () => false } as unknown as BrowserWindow;

    popSpellcheckMenu(
      { Menu: { buildFromTemplate }, window: fakeWindow },
      { params: makeParams(), spellCheckEnabled: true, actions: makeActions() },
    );

    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    const built = buildFromTemplate.mock.calls[0]?.[0];
    expect(shapeOf(built ?? [])).toEqual(['cut', 'copy', 'paste', 'selectAll']);
    expect(popup).toHaveBeenCalledWith({ window: fakeWindow });
  });

  test('destroyed window → no build, no popup (right-click racing window close)', () => {
    const { popup, buildFromTemplate } = makeMenuFakes();
    const fakeWindow = { id: 7, isDestroyed: () => true } as unknown as BrowserWindow;

    popSpellcheckMenu(
      { Menu: { buildFromTemplate }, window: fakeWindow },
      { params: makeParams(), spellCheckEnabled: true, actions: makeActions() },
    );

    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });
});
