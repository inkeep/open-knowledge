import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mdManager, schema } from './test-harness';

vi.doMock('sonner', () => ({ toast: { error: vi.fn(() => {}) } }));

let createHandlePaste: typeof import('../../src/editor/clipboard/handle-paste.ts').createHandlePaste;
beforeEach(async () => {
  ({ createHandlePaste } = await import('../../src/editor/clipboard/handle-paste.ts'));
});

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: { types: Object.keys(data), getData: (k: string) => data[k] ?? '' },
  } as unknown as ClipboardEvent;
}

function realStateView(initial: EditorState) {
  let state = initial;
  return {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
    current: () => state,
  };
}

function seedWithInteriorCaret(md: string): EditorState {
  const doc = schema.nodeFromJSON(mdManager.parse(md));
  const base = EditorState.create({ doc, schema });
  let jsxPos = -1;
  base.doc.descendants((node, pos) => {
    if (jsxPos === -1 && node.type.name === 'jsxComponent') {
      jsxPos = pos;
      return false;
    }
    return true;
  });
  expect(jsxPos).toBeGreaterThanOrEqual(0);
  const interiorCaret = jsxPos + 2;
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, interiorCaret)));
}

const REGISTERED_SEED = '<Callout type="info">\n\nbody\n\n</Callout>\n';
const UNREGISTERED_SEED = '<Steps>\n\nbody\n\n</Steps>\n';
const SEEDS: ReadonlyArray<{ label: string; md: string; name: string }> = [
  { label: 'registered Callout', md: REGISTERED_SEED, name: 'Callout' },
  { label: 'unregistered Steps', md: UNREGISTERED_SEED, name: 'Steps' },
];

function pasteIntoInterior(seedMd: string, expectedName: string, dt: ClipboardEvent) {
  const paste = createHandlePaste({ mdManager });
  const view = realStateView(seedWithInteriorCaret(seedMd));
  const handled = paste(view as never, dt);
  const doc = view.current().doc;
  expect(handled).toBe(true);
  expect(doc.childCount).toBe(1);
  const container = doc.firstChild;
  expect(container?.type.name).toBe('jsxComponent');
  expect(container?.attrs.componentName).toBe(expectedName);
  return container as NonNullable<typeof container>;
}

function interiorChildTypes(container: ReturnType<typeof pasteIntoInterior>): string[] {
  const types: string[] = [];
  container.forEach((child) => {
    types.push(child.type.name);
  });
  return types;
}

describe('WYSIWYG paste into a jsxComponent interior', () => {
  test('markdown pastes as nested blocks inside registered + unregistered interiors', () => {
    for (const seed of SEEDS) {
      const container = pasteIntoInterior(
        seed.md,
        seed.name,
        fakeDT({ 'text/plain': '## Head\n\n- one\n- two\n' }),
      );
      const childTypes = interiorChildTypes(container);
      expect(childTypes[0]).toBe('heading');
      expect(childTypes).toContain('list');
      const heading = container.child(0);
      expect(heading.textContent).toBe('Head');
      expect(container.lastChild?.type.name).toBe('paragraph');
      expect(container.lastChild?.textContent).toBe('body');
    }
  });

  test('an HTML table pastes as a nested table inside registered + unregistered interiors', () => {
    for (const seed of SEEDS) {
      const container = pasteIntoInterior(
        seed.md,
        seed.name,
        fakeDT({
          'text/plain': 'a\tb\nc\td',
          'text/html': '<table><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table>',
        }),
      );
      const childTypes = interiorChildTypes(container);
      expect(childTypes[0]).toBe('table');
      expect(container.child(0).childCount).toBeGreaterThan(0);
      expect(container.lastChild?.type.name).toBe('paragraph');
      expect(container.lastChild?.textContent).toBe('body');
    }
  });

  test('a nested JSX block pastes as a nested jsxComponent inside registered + unregistered interiors', () => {
    for (const seed of SEEDS) {
      const container = pasteIntoInterior(
        seed.md,
        seed.name,
        fakeDT({ 'text/plain': '<Callout type="note">\n\nnested body\n\n</Callout>\n' }),
      );
      const childTypes = interiorChildTypes(container);
      expect(childTypes[0]).toBe('jsxComponent');
      expect(container.child(0).attrs.componentName).toBe('Callout');
      expect(container.child(0).textContent).toBe('nested body');
      expect(container.lastChild?.type.name).toBe('paragraph');
      expect(container.lastChild?.textContent).toBe('body');
    }
  });
});
