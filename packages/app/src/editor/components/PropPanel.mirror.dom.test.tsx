import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';

type GlobalShims = typeof globalThis & { ResizeObserver?: unknown };
const g = globalThis as GlobalShims;
if (g.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
}

class FakeProvider {
  static instances: FakeProvider[] = [];
  document: Y.Doc;
  name: string;
  private syncedListeners: Array<() => void> = [];

  constructor(opts: { url: string; name: string; document: Y.Doc }) {
    this.document = opts.document;
    this.name = opts.name;
    FakeProvider.instances.push(this);
  }

  on(event: string, cb: () => void) {
    if (event === 'synced') this.syncedListeners.push(cb);
  }

  emitSynced() {
    for (const cb of this.syncedListeners) cb();
  }

  destroy() {}
}

vi.doMock('@hocuspocus/provider', () => ({ HocuspocusProvider: FakeProvider }));
vi.doMock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({ collabUrl: 'ws://test/collab' }),
}));

const pageTitles = new Map([
  ['pricing', 'Pricing'],
  ['team/handbook', 'Handbook'],
]);
const stubPageListValue = {
  pages: new Set(pageTitles.keys()),
  pagesBySlug: new Map<string, string>(),
  pagesByBasename: new Map<string, string>(),
  pageTitles,
  pageMeta: new Map<string, unknown>(),
  folderPaths: new Set<string>(),
  assetPaths: new Set<string>(),
  loading: false,
  error: null,
  refetch: () => {},
  addPage: () => {},
};
vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => stubPageListValue,
  useOptionalPageList: () => stubPageListValue,
}));

const { PropPanel } = await import('./PropPanel');
const { getDescriptor } = await import('../registry/index.ts');
const { disposeLiveDocPool } = await import('./live-doc-pool.ts');

const PRICING_SOURCE = [
  '# Pricing',
  '',
  '<MirrorSource name="plans">',
  '',
  'Starter is free. Team is $8 per seat.',
  '',
  '</MirrorSource>',
  '',
  '<MirrorSource id="faq">',
  '',
  'Can I switch plans?',
  '',
  '</MirrorSource>',
].join('\n');

function MirrorPanel({
  initial,
  onChange,
}: {
  initial: Record<string, unknown>;
  onChange: (propName: string, value: unknown) => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <PropPanel
      descriptor={getDescriptor('Mirror')}
      values={values}
      onChange={(propName, value) => {
        onChange(propName, value);
        setValues((current) => ({ ...current, [propName]: value }));
      }}
    />
  );
}

function optionTexts(): string[] {
  return screen.queryAllByTestId('suggestion-option').map((option) => option.textContent ?? '');
}

function serveDoc(docName: string, markdown: string) {
  const provider = FakeProvider.instances.find((candidate) => candidate.name === docName);
  if (!provider) throw new Error(`no live provider opened for ${docName}`);
  act(() => {
    const source = provider.document.getText('source');
    provider.document.transact(() => source.insert(0, markdown));
    provider.emitSynced();
  });
}

beforeEach(() => {
  FakeProvider.instances = [];
});

afterEach(() => {
  cleanup();
  disposeLiveDocPool();
});

describe('the Mirror property panel', () => {
  test('suggests documents for Src and picks the bare document name', () => {
    const onChange = vi.fn();
    render(<MirrorPanel initial={{}} onChange={onChange} />);

    fireEvent.click(document.getElementById('prop-src') as HTMLInputElement);
    expect(optionTexts()).toEqual(['Pricingpricing', 'Handbookteam/handbook']);

    fireEvent.change(document.getElementById('prop-src') as HTMLInputElement, {
      target: { value: 'hand' },
    });
    expect(optionTexts()).toEqual(['Handbookteam/handbook']);
    onChange.mockClear();
    fireEvent.mouseDown(screen.getByTestId('suggestion-option'));
    expect(onChange).toHaveBeenCalledWith('src', 'team/handbook');
  });

  test('suggests the Mirror Source names in the chosen document', () => {
    const onChange = vi.fn();
    render(<MirrorPanel initial={{ src: 'pricing' }} onChange={onChange} />);
    serveDoc('pricing', PRICING_SOURCE);

    fireEvent.click(document.getElementById('prop-name') as HTMLInputElement);
    expect(optionTexts()).toEqual([
      'plansStarter is free. Team is $8 per seat.',
      'faqCan I switch plans?',
    ]);

    const faq = screen.getAllByTestId('suggestion-option')[1];
    fireEvent.mouseDown(faq as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('name', 'faq');
  });

  test('narrows the name suggestions to what is typed, by name or by content', () => {
    render(<MirrorPanel initial={{ src: 'pricing' }} onChange={() => {}} />);
    serveDoc('pricing', PRICING_SOURCE);
    const nameField = document.getElementById('prop-name') as HTMLInputElement;

    fireEvent.change(nameField, { target: { value: 'fa' } });
    expect(optionTexts()).toEqual(['faqCan I switch plans?']);

    fireEvent.change(nameField, { target: { value: 'seat' } });
    expect(optionTexts()).toEqual(['plansStarter is free. Team is $8 per seat.']);
  });

  test.each([
    ['a numeric Src as its text', { src: 42, name: 'plans' }, 'prop-src', '42'],
    ['a valueless Name as an empty field', { src: 'pricing', name: true }, 'prop-name', ''],
  ])('shows %s instead of failing', (_case, initial, fieldId, shown) => {
    render(<MirrorPanel initial={initial} onChange={() => {}} />);
    expect((document.getElementById(fieldId) as HTMLInputElement).value).toBe(shown);
  });

  test('lets an IME confirm its text without picking a suggestion', () => {
    const onChange = vi.fn();
    render(<MirrorPanel initial={{}} onChange={onChange} />);
    const srcField = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.change(srcField, { target: { value: 'pri' } });
    onChange.mockClear();

    fireEvent.keyDown(srcField, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(srcField, { key: 'Enter', keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(srcField, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('src', 'pricing');
  });

  test('says so once the chosen document turns out to have no Mirror Sources', () => {
    render(<MirrorPanel initial={{ src: 'pricing' }} onChange={() => {}} />);
    const nameField = document.getElementById('prop-name') as HTMLInputElement;
    const announcement = within(nameField.parentElement as HTMLElement).getByRole('status');
    fireEvent.click(nameField);
    expect(announcement.textContent).toBe('');
    expect(screen.queryByText(/No Mirror Source blocks/)).toBeNull();

    serveDoc('pricing', '# Pricing\n\nStarter is free.\n');
    expect(announcement.textContent).toBe('No Mirror Source blocks in pricing');
    expect(screen.getByText('No Mirror Source blocks in pricing', { selector: 'p' })).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(nameField.getAttribute('aria-expanded')).toBe('false');
  });

  test.each([
    ['with Mirror Sources', PRICING_SOURCE],
    ['without Mirror Sources', '# Pricing\n\nStarter is free.\n'],
  ])(
    'stays closed for a Src document %s once focus has moved from Name to Src',
    (_case, markdown) => {
      render(<MirrorPanel initial={{}} onChange={() => {}} />);
      const nameField = document.getElementById('prop-name') as HTMLInputElement;
      const srcField = document.getElementById('prop-src') as HTMLInputElement;
      act(() => nameField.focus());
      fireEvent.click(nameField);
      act(() => srcField.focus());
      fireEvent.change(srcField, { target: { value: 'pricing' } });
      serveDoc('pricing', markdown);

      expect(nameField.getAttribute('aria-expanded')).toBe('false');
      expect(within(nameField.parentElement as HTMLElement).getByRole('status').textContent).toBe(
        '',
      );
    },
  );

  test('reads a numeric Src as the document its text names', () => {
    stubPageListValue.pages.add('42');
    try {
      render(<MirrorPanel initial={{ src: 42 }} onChange={() => {}} />);
      fireEvent.click(document.getElementById('prop-name') as HTMLInputElement);
      serveDoc('42', '<MirrorSource name="answer">\n\nForty-two.\n\n</MirrorSource>');
      expect(optionTexts()).toEqual(['answerForty-two.']);
    } finally {
      stubPageListValue.pages.delete('42');
    }
  });

  test('keeps focus in Name when a press lands on the popup outside an option', async () => {
    const user = userEvent.setup();
    render(<MirrorPanel initial={{ src: 'pricing' }} onChange={() => {}} />);
    const nameField = document.getElementById('prop-name') as HTMLInputElement;
    await user.click(nameField);
    serveDoc('pricing', '# Pricing\n\nStarter is free.\n');

    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByText('No Mirror Source blocks in pricing', { selector: 'p' }),
    });
    expect(document.activeElement).toBe(nameField);
    expect(screen.getByText('No Mirror Source blocks in pricing', { selector: 'p' })).toBeTruthy();
  });

  test('says once when the stored name matches none of the document’s Mirror Sources', () => {
    render(<MirrorPanel initial={{ src: 'pricing', name: 'pricnig' }} onChange={() => {}} />);
    serveDoc('pricing', PRICING_SOURCE);
    const nameField = document.getElementById('prop-name') as HTMLInputElement;
    const announcement = within(nameField.parentElement as HTMLElement).getByRole('status');
    fireEvent.click(nameField);

    const message =
      'No Mirror Source block in pricing matches the text in this field. Clear it to see them all.';
    expect(announcement.textContent).toBe(message);
    expect(screen.getByText(message, { selector: 'p' })).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(nameField, { target: { value: 'pricnigx' } });
    expect(announcement.textContent).toBe(message);
  });

  test('opens no live document for a Src that names no document', () => {
    render(<MirrorPanel initial={{ src: 'pric' }} onChange={() => {}} />);

    fireEvent.click(document.getElementById('prop-name') as HTMLInputElement);
    expect(FakeProvider.instances).toEqual([]);
    expect(optionTexts()).toEqual([]);
  });
});
