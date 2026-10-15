import { StreamLanguage } from '@codemirror/language';
import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';
import { okCmTheme } from '@/editor/extensions/cm-theme';
import { sourceModeSetup } from '@/editor/source-mode-setup';
import { sourceCharacterMeasurements } from './theme-contrast.test-helper';

const ROLES = [
  { name: 'foreground', tag: tags.strong },
  { name: 'link-color', tag: tags.link },
  { name: 'syntax-func', tag: tags.function(tags.variableName) },
  { name: 'syntax-attr', tag: tags.attributeName },
  { name: 'syntax-string', tag: tags.string },
  { name: 'syntax-comment', tag: tags.comment },
  { name: 'syntax-keyword', tag: tags.keyword },
  { name: 'muted-foreground', tag: tags.processingInstruction },
  { name: 'syntax-meta', tag: tags.meta },
  { name: 'syntax-tag', tag: tags.tagName },
  { name: 'syntax-type', tag: tags.typeName },
  { name: 'syntax-var', tag: tags.variableName },
  { name: 'syntax-number', tag: tags.number },
  { name: 'syntax-atom', tag: tags.atom },
  { name: 'syntax-operator', tag: tags.operator },
  { name: 'diff-added', tag: tags.inserted },
  { name: 'diff-removed', tag: tags.deleted },
  { name: 'destructive', tag: tags.invalid },
] as const;
const STATES = [
  'ordinary',
  'active',
  'plain-search',
  'selected-search',
  'selection-match',
  'primary',
  'secondary',
  'secondary-search',
] as const;
const LINE = 'MMMM same MMMM';
const DOC = `${LINE}\n${LINE}\n${LINE}\n${LINE}\n${LINE}\n`;
let stylesheet: HTMLStyleElement;
beforeAll(async () => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = await commands.buildAppStylesheet();
  document.head.append(stylesheet);
});
afterAll(() => stylesheet.remove());

async function settle(view: EditorView) {
  await new Promise<void>((resolve) =>
    view.requestMeasure({
      read: () => undefined,
      write: () => requestAnimationFrame(() => resolve()),
    }),
  );
}

for (const mode of ['light', 'dark'] as const) {
  describe(`default ${mode} editor syntax in highlight states`, () => {
    for (const role of ROLES) {
      test(`${role.name} keeps its color and remains readable`, async () => {
        document.documentElement.classList.toggle('dark', mode === 'dark');
        delete document.documentElement.dataset.colorTheme;
        document.documentElement.style.colorScheme = mode;
        try {
          for (const background of ['var(--background)', 'var(--syntax-bg)', 'var(--muted)']) {
            const host = document.createElement('div');
            host.style.cssText = `width:850px;padding:24px;background:${background};color:var(--foreground)`;
            document.body.append(host);
            const language = StreamLanguage.define({
              token(stream) {
                if (stream.eatSpace()) return null;
                stream.eatWhile(/\S/);
                return 'sample';
              },
              tokenTable: { sample: role.tag },
            });
            const view = new EditorView({
              parent: host,
              state: EditorState.create({
                doc: DOC,
                extensions: [sourceModeSetup, language, okCmTheme({ dark: mode === 'dark' })],
              }),
            });
            try {
              await settle(view);
              const token = view.contentDOM.querySelector('.cm-line span');
              expect(token).not.toBeNull();
              if (!token) throw new Error('Syntax token did not render');
              const ordinaryColor = getComputedStyle(token).color;
              for (const state of STATES) {
                closeSearchPanel(view);
                view.dispatch({
                  effects: setSearchQuery.of(new SearchQuery({ search: '' })),
                  selection: EditorSelection.cursor(DOC.length),
                });
                if (state === 'active') view.dispatch({ selection: EditorSelection.cursor(2) });
                if (state === 'primary' || state === 'selection-match')
                  view.dispatch({ selection: EditorSelection.range(0, 4) });
                if (state === 'secondary' || state === 'secondary-search')
                  view.dispatch({
                    selection: EditorSelection.create(
                      [EditorSelection.range(0, 4), EditorSelection.range(17, 46)],
                      0,
                    ),
                  });
                if (
                  state === 'plain-search' ||
                  state === 'selected-search' ||
                  state === 'secondary-search'
                ) {
                  openSearchPanel(view);
                  view.dispatch({
                    effects: setSearchQuery.of(new SearchQuery({ search: 'MMMM' })),
                  });
                  if (state === 'selected-search') findNext(view);
                  if (state === 'secondary-search') view.focus();
                } else view.focus();
                await settle(view);
                let offset = 0;
                let targets = 0;
                for (const line of DOC.split('\n')) {
                  if (!line.length) continue;
                  for (const reading of sourceCharacterMeasurements(
                    view,
                    offset,
                    offset + line.length,
                  )) {
                    if (!reading.text.trim()) continue;
                    const at = view.domAtPos(reading.position);
                    const element =
                      at.node.nodeType === Node.TEXT_NODE
                        ? at.node.parentElement
                        : (at.node as Element);
                    if (!element) throw new Error('Missing syntax element');
                    const active = !!element.closest('.cm-activeLine');
                    const search = !!element.closest('.cm-searchMatch');
                    const selectedSearch = !!element.closest('.cm-searchMatch-selected');
                    const match = !!element.closest('.cm-selectionMatch');
                    const primary = reading.position < 4;
                    const target =
                      state === 'ordinary'
                        ? !active
                        : state === 'active'
                          ? active
                          : state === 'plain-search'
                            ? search && !selectedSearch
                            : state === 'selected-search'
                              ? selectedSearch
                              : state === 'selection-match'
                                ? match && !reading.selected
                                : state === 'primary'
                                  ? reading.selected && primary
                                  : reading.selected && !primary;
                    if (!target) continue;
                    targets++;
                    expect
                      .soft(reading.foreground, `${background} ${state} preserves syntax`)
                      .toBe(ordinaryColor);
                    expect
                      .soft(
                        reading.ratio,
                        `${background} ${state} ${role.name} on ${JSON.stringify(reading.background)}`,
                      )
                      .toBeGreaterThanOrEqual(4.5);
                  }
                  offset += line.length + 1;
                }
                expect(targets, `${background} ${state} renders`).toBeGreaterThan(0);
              }
            } finally {
              view.destroy();
              host.remove();
            }
          }
        } finally {
          document.documentElement.classList.remove('dark');
          document.documentElement.style.removeProperty('color-scheme');
        }
      });
    }
  });
}
