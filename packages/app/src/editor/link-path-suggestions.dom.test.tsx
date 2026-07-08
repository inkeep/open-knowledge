import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  isLinkPathSuggestionPanelTarget,
  type LinkPathSuggestion,
  LinkPathSuggestionInput,
  preventLinkPathSuggestionDialogDismiss,
} from './link-path-suggestions';

const pages = new Set(['docs/install', 'guides/bun', 'guides/intro']);
const folderPaths = new Set(['docs', 'guides']);
const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView;
let pointerEventsStyle: HTMLStyleElement | null = null;

function Harness({
  initialValue,
  loading = false,
  harnessPages = pages,
  harnessFolderPaths = folderPaths,
  onSelect,
}: {
  initialValue: string;
  loading?: boolean;
  harnessPages?: Set<string>;
  harnessFolderPaths?: Set<string>;
  onSelect?: (suggestion: LinkPathSuggestion) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <LinkPathSuggestionInput
      aria-label="Link target"
      value={value}
      pages={harnessPages}
      folderPaths={harnessFolderPaths}
      loading={loading}
      onValueChange={setValue}
      onSuggestionSelect={(suggestion) => {
        onSelect?.(suggestion);
        setValue(suggestion.path);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  pointerEventsStyle?.remove();
  pointerEventsStyle = null;
  if (nativeScrollIntoView) {
    HTMLElement.prototype.scrollIntoView = nativeScrollIntoView;
  } else {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

describe('LinkPathSuggestionInput', () => {
  test('opens project path suggestions when empty input has focus', () => {
    render(<Harness initialValue="" />);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Link target' }));

    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();
    expect(screen.getByRole('option', { name: '/docs/install Page' })).toBeDefined();
  });

  test('opens project path suggestions when slash input has focus', () => {
    render(<Harness initialValue="/guides" />);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Link target' }));

    const listbox = screen.getByRole('listbox', { name: 'Path suggestions' });
    expect(listbox.parentElement).toBe(document.body);
    expect(screen.getByRole('option', { name: '/guides Folder' })).toBeDefined();
    expect(screen.getByRole('option', { name: '/guides/bun Page' })).toBeDefined();
    expect(screen.getByRole('option', { name: '/guides/intro Page' })).toBeDefined();
  });

  test('shows an empty state for slash input with no matching paths', () => {
    render(<Harness initialValue="/" harnessPages={new Set()} harnessFolderPaths={new Set()} />);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Link target' }));

    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('No matching paths');
  });

  test('shows loading state for slash input while paths load', () => {
    render(
      <Harness initialValue="/" loading harnessPages={new Set()} harnessFolderPaths={new Set()} />,
    );

    fireEvent.focus(screen.getByRole('combobox', { name: 'Link target' }));

    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('Loading paths…');
  });

  test('selects the highlighted suggestion before the caller handles Enter', () => {
    const selected: LinkPathSuggestion[] = [];
    render(<Harness initialValue="/bun" onSelect={(suggestion) => selected.push(suggestion)} />);

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(selected).toEqual([{ kind: 'page', path: 'guides/bun' }]);
    expect((input as HTMLInputElement).value).toBe('guides/bun');
  });

  test('selects clicked suggestions from the portaled listbox', () => {
    const selected: LinkPathSuggestion[] = [];
    render(<Harness initialValue="/docs" onSelect={(suggestion) => selected.push(suggestion)} />);

    fireEvent.focus(screen.getByRole('combobox', { name: 'Link target' }));
    fireEvent.click(screen.getByRole('option', { name: '/docs/install Page' }));

    expect(selected).toEqual([{ kind: 'page', path: 'docs/install' }]);
  });

  test('keeps scroll gestures inside the portaled listbox', () => {
    let wheelEvents = 0;
    let touchMoveEvents = 0;
    render(
      <div
        onWheel={() => {
          wheelEvents += 1;
        }}
        onTouchMove={() => {
          touchMoveEvents += 1;
        }}
      >
        <Harness initialValue="/" />
      </div>,
    );

    fireEvent.focus(screen.getByRole('combobox', { name: 'Link target' }));
    const listbox = screen.getByRole('listbox', { name: 'Path suggestions' });
    fireEvent.wheel(listbox);
    fireEvent.touchMove(listbox);

    expect(wheelEvents).toBe(0);
    expect(touchMoveEvents).toBe(0);
  });

  test('keeps portaled suggestions interactive inside modal dialogs', () => {
    pointerEventsStyle = document.createElement('style');
    pointerEventsStyle.textContent = '.pointer-events-auto { pointer-events: auto; }';
    document.head.append(pointerEventsStyle);

    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Edit markdown link</DialogTitle>
          <Harness
            initialValue="/"
            harnessPages={new Set(Array.from({ length: 12 }, (_, index) => `docs/${index}`))}
            harnessFolderPaths={new Set()}
          />
        </DialogContent>
      </Dialog>,
    );

    fireEvent.focus(screen.getByRole('combobox', { name: 'Link target' }));

    const listbox = screen.getByRole('listbox', { name: 'Path suggestions' });
    expect(document.body.style.pointerEvents).toBe('none');
    expect(listbox.parentElement).toBe(document.body);
    expect(getComputedStyle(listbox).pointerEvents).toBe('auto');
    expect(isLinkPathSuggestionPanelTarget(listbox)).toBe(true);

    let prevented = false;
    preventLinkPathSuggestionDialogDismiss({
      target: listbox,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });

  test('Escape dismisses the suggestion panel', () => {
    render(<Harness initialValue="/guides" />);

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox', { name: 'Path suggestions' })).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  test('typing after Escape reopens the suggestion panel', () => {
    render(<Harness initialValue="/guides" />);

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Path suggestions' })).toBeNull();

    fireEvent.change(input, { target: { value: '/guide' } });

    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();
  });

  test('Escape dismisses empty-input suggestions and typing reopens them', () => {
    render(<Harness initialValue="" />);

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Path suggestions' })).toBeNull();

    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();
  });

  test('after Escape dismisses the panel, keys reach the parent onKeyDown', () => {
    // Suggestions still EXIST for the value after dismissal — only the panel is
    // hidden. Keys must not be swallowed against the invisible panel: the next
    // Escape has to reach the parent popover/dialog (which closes on it) and
    // Enter has to reach the parent's apply handler.
    const seen: string[] = [];
    render(
      <LinkPathSuggestionInput
        aria-label="Link target"
        value=""
        pages={pages}
        folderPaths={folderPaths}
        onValueChange={() => {}}
        onKeyDown={(event) => seen.push(event.key)}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeDefined();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Path suggestions' })).toBeNull();
    expect(seen).toEqual([]);

    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(seen).toEqual(['Escape', 'Enter']);
  });

  test('ArrowDown and ArrowUp update the active option', () => {
    render(<Harness initialValue="/guides" />);

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    let options = screen.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    options = screen.getAllByRole('option');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    options = screen.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
  });

  test('keyboard navigation scrolls the active option into view', async () => {
    const scrollTargets: string[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
      scrollTargets.push(this.getAttribute('aria-label') ?? '');
    };
    const manyPages = new Set(Array.from({ length: 12 }, (_, index) => `guides/${index}`));
    render(
      <Harness initialValue="/guides" harnessPages={manyPages} harnessFolderPaths={new Set()} />,
    );

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    scrollTargets.length = 0;

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(scrollTargets).toContain('/guides/1 Page');
    });
  });

  test('Enter selects the navigated suggestion', () => {
    const selected: LinkPathSuggestion[] = [];
    render(<Harness initialValue="/guides" onSelect={(suggestion) => selected.push(suggestion)} />);

    const input = screen.getByRole('combobox', { name: 'Link target' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(selected).toEqual([{ kind: 'page', path: 'guides/bun' }]);
    expect((input as HTMLInputElement).value).toBe('guides/bun');
  });
});
