/**
 * Unit tests for the editor spellcheck context-menu template + pop dispatch.
 * Covers section composition per `ContextMenuParams` (edit roles, spellcheck
 * rows, Look Up / Search), separator omission for empty sections, and callback
 * dispatch wiring. Mirrors `asset-menu.test.ts` — template shape is exercised
 * without mounting Electron's Menu.
 */

import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import {
  type BuildSpellcheckMenuTemplateParams,
  buildSpellcheckMenuTemplate,
  popSpellcheckMenu,
  type SpellcheckMenuParams,
} from '../../src/main/spellcheck-menu.ts';

function makeActions() {
  return {
    replaceMisspelling: vi.fn((_: string) => {}),
    addToDictionary: vi.fn((_: string) => {}),
    setSpellCheckEnabled: vi.fn((_: boolean) => {}),
    lookUp: vi.fn(() => {}),
    search: vi.fn((_: string) => {}),
    viewInSource: vi.fn(() => {}),
  };
}

// The view-in-source jump trails every section-composition case below, which
// all build with the jump live (`canViewInSource` defaults to true in `build`).
// Its own gate is covered by the not-live cases at the end of the describe.
const VIEW_ROW = 'View in Source Markdown';

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
  canViewInSource = true,
): MenuItemConstructorOptions[] {
  return buildSpellcheckMenuTemplate({ params, spellCheckEnabled, canViewInSource, actions });
}

/** Project a template to a comparable shape: role, label, or separator marker. */
function shapeOf(template: MenuItemConstructorOptions[]): string[] {
  return template.map((e) => e.role ?? e.label ?? `[${e.type}]`);
}

describe('buildSpellcheckMenuTemplate — section composition', () => {
  test('editable text with no misspelling and no selection → edit roles + View in Source', () => {
    const template = build(makeParams(), true, makeActions());
    expect(shapeOf(template)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      VIEW_ROW,
    ]);
  });

  test('edit roles respect editFlags', () => {
    const params = makeParams({
      editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: false },
    });
    const template = build(params, true, makeActions());
    expect(shapeOf(template)).toEqual(['copy', 'paste', '[separator]', VIEW_ROW]);
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
      '[separator]',
      VIEW_ROW,
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
      '[separator]',
      VIEW_ROW,
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
      '[separator]',
      VIEW_ROW,
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
      '[separator]',
      VIEW_ROW,
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
      '[separator]',
      VIEW_ROW,
    ]);
  });

  test('no edit/spell/lookup rows → View in Source alone (no dangling separators)', () => {
    // With the jump live and nothing else to offer, the view row is the sole
    // entry, with no leading separator.
    const params = makeParams({
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    });
    const template = build(params, true, makeActions());
    expect(shapeOf(template)).toEqual([VIEW_ROW]);
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
      '[separator]',
      VIEW_ROW,
    ]);
  });

  test('View in Source is the last row on a fully-populated menu', () => {
    const params = makeParams({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      selectionText: 'teh fox',
    });
    const template = build(params, true, makeActions());
    const shape = shapeOf(template);
    // Appended after everything else, behind its own separator.
    expect(shape.at(-1)).toBe(VIEW_ROW);
    expect(shape.at(-2)).toBe('[separator]');
  });

  // The menu attaches to every editable field in the window, and the jump only
  // means something over a document open in the visual editor. Everywhere else
  // — the composer, a rename field, a dialog input, source mode, no document —
  // the row is omitted rather than shown inert or greyed.
  test('the jump not being live omits the row, leaving the rest intact', () => {
    const params = makeParams({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the'],
      selectionText: 'teh fox',
    });
    const template = build(params, true, makeActions(), false);
    expect(shapeOf(template)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      'the',
      'Add to Dictionary',
      'Disable Spell Check',
      '[separator]',
      'Look Up "teh fox"',
      'Search with Google',
    ]);
  });

  test('the omitted row takes its separator with it', () => {
    const template = build(makeParams(), true, makeActions(), false);
    expect(shapeOf(template)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
  });

  test('a capability-less field with the jump not live gets no menu rows at all', () => {
    // The case that made the row unconditional-looking: an editable target with
    // no edit flags, no misspelling and no selection. It must now come back
    // empty rather than offering a lone row that does nothing.
    const params = makeParams({
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    });
    expect(build(params, true, makeActions(), false)).toEqual([]);
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

  test('View in Source fires the viewInSource action', () => {
    const actions = makeActions();
    const template = build(makeParams(), true, actions);
    clickRow(template, VIEW_ROW);
    expect(actions.viewInSource).toHaveBeenCalledTimes(1);
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
    const popup = vi.fn((_: unknown) => {});
    const menuInstance = { popup } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    const buildFromTemplate = vi.fn((_: MenuItemConstructorOptions[]) => menuInstance);
    return { popup, buildFromTemplate };
  }

  test('builds the template from the given params + pops via injected Menu ctor', () => {
    const { popup, buildFromTemplate } = makeMenuFakes();
    const fakeWindow = { id: 7, isDestroyed: () => false } as unknown as BrowserWindow;

    popSpellcheckMenu(
      { Menu: { buildFromTemplate }, window: fakeWindow },
      {
        params: makeParams(),
        spellCheckEnabled: true,
        canViewInSource: true,
        actions: makeActions(),
      },
    );

    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    const built = buildFromTemplate.mock.calls[0]?.[0];
    expect(shapeOf(built ?? [])).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
      '[separator]',
      VIEW_ROW,
    ]);
    expect(popup).toHaveBeenCalledWith({ window: fakeWindow });
  });

  test('destroyed window → no build, no popup (right-click racing window close)', () => {
    const { popup, buildFromTemplate } = makeMenuFakes();
    const fakeWindow = { id: 7, isDestroyed: () => true } as unknown as BrowserWindow;

    popSpellcheckMenu(
      { Menu: { buildFromTemplate }, window: fakeWindow },
      {
        params: makeParams(),
        spellCheckEnabled: true,
        canViewInSource: true,
        actions: makeActions(),
      },
    );

    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });
});
