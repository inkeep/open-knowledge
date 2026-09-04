import { cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TagPillInput } from './tag-pill-input';

interface RenderOpts {
  value?: string[];
  onChange?: (next: string[]) => void;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

function renderInput(opts: RenderOpts = {}) {
  const onChange = opts.onChange ?? vi.fn(() => {});
  const result = render(
    <TooltipProvider>
      <TagPillInput
        value={opts.value ?? []}
        onChange={onChange}
        id={opts.id}
        aria-describedby={opts['aria-describedby']}
        aria-invalid={opts['aria-invalid']}
      />
    </TooltipProvider>,
  );
  return { ...result, onChange };
}

describe('TagPillInput — render-side invalid pill flagging', () => {
  afterEach(() => {
    cleanup();
  });

  test('seed of mixed valid + invalid pills flags only the invalid ones', () => {
    const { container } = renderInput({
      value: ['showcase', '2026', 'has spaces', 'proj/team'],
    });
    const invalid = container.querySelectorAll('[data-tag-invalid="true"]');
    expect(invalid).toHaveLength(1);
    const texts = Array.from(invalid).map((el) => el.textContent ?? '');
    expect(texts.some((t) => t.includes('2026'))).toBe(false);
    expect(texts.some((t) => t.includes('has spaces'))).toBe(true);
  });

  test('invalid pill is wrapped in a Radix Tooltip trigger (content lazy-renders)', () => {
    const { container } = renderInput({ value: ['bad!'] });
    const invalidBadge = container.querySelector('[data-tag-invalid="true"]');
    expect(invalidBadge?.getAttribute('data-slot')).toBe('tooltip-trigger');
  });

  test('valid pill is NOT tooltip-wrapped (no extra DOM ceremony for legit tags)', () => {
    const { container } = renderInput({ value: ['showcase'] });
    const badge = container.querySelector('.font-mono')?.closest('[data-slot]');
    expect(badge?.getAttribute('data-slot')).not.toBe('tooltip-trigger');
  });
});

describe('TagPillInput — input-side grammar gate', () => {
  afterEach(() => {
    cleanup();
  });

  test('Enter on invalid input does not commit; draft + role="alert" helper appear', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('bad!');
    expect(input.getAttribute('data-tag-invalid')).toBe('true');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = container.querySelector('[data-testid="tag-pill-input-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Tags must start with a letter');
  });

  test('Enter on valid input commits + clears draft + clears any prior rejection state', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(['showcase']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('comma, Tab, and blur commit non-empty drafts while empty comma is swallowed', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ onChange });
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'comma-tag' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledWith(['comma-tag']);

    fireEvent.change(input, { target: { value: 'tab-tag' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith(['tab-tag']);

    fireEvent.change(input, { target: { value: 'blur-tag' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['blur-tag']);
  });

  test('Backspace on an empty draft removes the last pill', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ value: ['alpha', 'beta'], onChange });
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.keyDown(input, { key: 'Backspace' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(['alpha']);
  });

  test('Enter on a digit-leading tag like a year (2026) commits', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(['2026']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('typing clears rejection state for the next commit attempt', () => {
    const { container } = renderInput();
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: 'bad!x' } });
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('Escape clears rejection without committing', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(0);
  });

  test('input strips leading `#` before commit (Obsidian-shape paste tolerance)', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(['showcase']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('post-normalize dedup catches `#`x vs x (no double commit)', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ value: ['showcase'], onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('duplicate tag silently dedupes (no commit, no rejection state)', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ value: ['showcase'], onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('TagPillInput — free-text grammar', () => {
  afterEach(() => {
    cleanup();
  });

  function renderFreeText(opts: RenderOpts = {}) {
    const onChange = opts.onChange ?? vi.fn(() => {});
    const result = render(
      <TooltipProvider>
        <TagPillInput value={opts.value ?? []} onChange={onChange} grammar="free-text" />
      </TooltipProvider>,
    );
    return { ...result, onChange };
  }

  test('commits values the tag grammar rejects, verbatim — no leading-# strip', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderFreeText({ onChange });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '## Summary' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(['## Summary']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('never flags seeded pills as invalid (no tag-grammar styling)', () => {
    const { container } = renderFreeText({ value: ['## Summary', '*', 'has spaces'] });
    expect(container.querySelectorAll('[data-tag-invalid="true"]')).toHaveLength(0);
  });

  test('still trims, drops empty drafts, and dedupes', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderFreeText({ value: ['*'], onChange });
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(0);

    fireEvent.change(input, { target: { value: '*' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(0);
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: '  ## Details  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['*', '## Details']);
  });
});

describe('TagPillInput — a11y id wiring (regression: PR #1288 review findings)', () => {
  afterEach(() => {
    cleanup();
  });

  test('grammar-hint id is derived from the caller-supplied `id` prop (per-instance unique)', () => {
    const { container } = renderInput({ id: 'my-tags-field' });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const alert = container.querySelector('[data-testid="tag-pill-input-error"]');
    expect(alert?.id).toBe('my-tags-field-grammar-hint');
  });

  test('two TagPillInputs on the same page get distinct grammar-hint ids (no static collision)', () => {
    const { container } = render(
      <TooltipProvider>
        <TagPillInput id="left" value={[]} onChange={() => {}} />
        <TagPillInput id="right" value={[]} onChange={() => {}} />
      </TooltipProvider>,
    );
    const [leftInput, rightInput] = container.querySelectorAll('input');
    fireEvent.change(leftInput as HTMLInputElement, { target: { value: 'bad!' } });
    fireEvent.keyDown(leftInput as HTMLInputElement, { key: 'Enter' });
    fireEvent.change(rightInput as HTMLInputElement, { target: { value: 'has spaces' } });
    fireEvent.keyDown(rightInput as HTMLInputElement, { key: 'Enter' });
    const alerts = container.querySelectorAll('[data-testid="tag-pill-input-error"]');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.id).toBe('left-grammar-hint');
    expect(alerts[1]?.id).toBe('right-grammar-hint');
  });

  test('aria-describedby MERGES the caller id with the grammar-hint id (does not clobber)', () => {
    const { container } = renderInput({
      id: 'my-field',
      'aria-describedby': 'my-field-rhf-error',
    });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const describedby = input.getAttribute('aria-describedby') ?? '';
    const ids = describedby.split(/\s+/).filter(Boolean);
    expect(ids).toContain('my-field-grammar-hint');
    expect(ids).toContain('my-field-rhf-error');
  });

  test('aria-describedby with no rejection just forwards the caller-supplied id', () => {
    const { container } = renderInput({
      id: 'my-field',
      'aria-describedby': 'my-field-rhf-error',
    });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')).toBe('my-field-rhf-error');
  });

  test('aria-describedby with neither rejection nor caller id is undefined (no empty string)', () => {
    const { container } = renderInput();
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  test('remove buttons include the tag value in their accessible names', () => {
    const onChange = vi.fn(() => {});
    const { container } = renderInput({ value: ['showcase', 'docs'], onChange });

    fireEvent.click(
      container.querySelector('button[aria-label="Remove docs"]') as HTMLButtonElement,
    );

    expect(onChange).toHaveBeenCalledWith(['showcase']);
  });

  test('forwards id, ref, aria-describedby, and aria-invalid to the focusable input and wrapper state', () => {
    const inputRef = createRef<HTMLInputElement>();
    const { container } = render(
      <TooltipProvider>
        <TagPillInput
          value={[]}
          onChange={() => {}}
          id="frontmatter-tags"
          ref={inputRef}
          aria-describedby="frontmatter-tags-error"
          aria-invalid="true"
        />
      </TooltipProvider>,
    );

    const input = container.querySelector('input') as HTMLInputElement;
    const wrapper = container.querySelector('[data-slot="tag-pill-input"]');
    expect(input.id).toBe('frontmatter-tags');
    expect(inputRef.current).toBe(input);
    expect(input.getAttribute('aria-describedby')).toBe('frontmatter-tags-error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(wrapper?.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('TagPillInput — pills read as authored', () => {
  afterEach(() => {
    cleanup();
  });

  test('pills do not inherit the Badge uppercase transform', () => {
    const { container } = render(
      <TooltipProvider>
        <TagPillInput value={['blog/**']} onChange={() => {}} grammar="free-text" />
      </TooltipProvider>,
    );
    const pill = container.querySelector('[data-slot="badge"]') ?? container.querySelector('span');
    expect(pill?.className).toContain('normal-case');
    expect(pill?.className).not.toContain('uppercase');
  });
});

describe('TagPillInput — per-entry problems', () => {
  afterEach(() => {
    cleanup();
  });

  function renderWithProblems(problems: [string, string][], value: string[]) {
    return render(
      <TooltipProvider>
        <TagPillInput
          value={value}
          onChange={() => {}}
          grammar="free-text"
          entryProblems={new Map(problems)}
        />
      </TooltipProvider>,
    );
  }

  test('flags only the entry named by a problem', () => {
    const { container } = renderWithProblems(
      [['specs/**', 'matches no docs in this project']],
      ['docs/**', 'specs/**'],
    );
    const flagged = container.querySelectorAll('[data-tag-problem="true"]');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain('specs/**');
  });

  test('a flagged entry is tooltip-wrapped so the message is reachable on hover', () => {
    const { container } = renderWithProblems(
      [['specs/**', 'matches no docs in this project']],
      ['specs/**'],
    );
    const badge = container.querySelector('[data-tag-problem="true"]');
    expect(badge?.getAttribute('data-state')).toBe('closed');
  });

  test('entries with no problem stay unflagged and untooltipped', () => {
    const { container } = renderWithProblems([['specs/**', 'nope']], ['docs/**']);
    expect(container.querySelectorAll('[data-tag-problem="true"]')).toHaveLength(0);
    expect(container.querySelector('[data-slot="badge"]')?.getAttribute('data-state')).toBeNull();
  });

  test('free-text entries are not flagged by the tag grammar (problems are the only source)', () => {
    const { container } = renderWithProblems([], ['## Summary']);
    expect(container.querySelectorAll('[data-tag-invalid="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-tag-problem="true"]')).toHaveLength(0);
  });

  test('double-clicking a flagged entry lifts it into the input for correction', () => {
    const { container } = renderWithProblems(
      [['specs/**', 'matches no docs in this project']],
      ['specs/**'],
    );
    const editButton = [...container.querySelectorAll('[data-slot="tag-pill-input"] button')].find(
      (el) => el.textContent === 'specs/**',
    ) as HTMLElement;
    fireEvent.doubleClick(editButton);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('specs/**');
    expect(document.activeElement).toBe(input);
  });

  test('the tooltip on a flagged entry reports the problem detail', async () => {
    const { container, findByRole } = renderWithProblems(
      [['specs/**', 'matches no docs in this project']],
      ['specs/**'],
    );
    fireEvent.focus(container.querySelector('[data-tag-problem="true"]') as HTMLElement);
    const tooltip = await findByRole('tooltip');
    expect(tooltip.textContent).toContain('matches no docs in this project');
  });

  test('a flagged entry drops the native edit title so tooltips do not compete', () => {
    const { container } = renderWithProblems(
      [['specs/**', 'matches no docs in this project']],
      ['docs/**', 'specs/**'],
    );
    const buttons = [...container.querySelectorAll('[data-slot="tag-pill-input"] button')];
    const flaggedEdit = buttons.find((el) => el.textContent === 'specs/**') as HTMLElement;
    const okEdit = buttons.find((el) => el.textContent === 'docs/**') as HTMLElement;
    expect(flaggedEdit.getAttribute('title')).toBeNull();
    expect(okEdit.getAttribute('title')).toBe('Double-click to edit');
  });
});

describe('TagPillInput — double-click to edit', () => {
  afterEach(() => {
    cleanup();
  });

  function renderEditable(value: string[], onChange = vi.fn(() => {})) {
    const result = render(
      <TooltipProvider>
        <TagPillInput value={value} onChange={onChange} grammar="free-text" />
      </TooltipProvider>,
    );
    const input = result.container.querySelector('input') as HTMLInputElement;
    const label = (text: string) =>
      [...result.container.querySelectorAll('[data-slot="badge"] button')].find(
        (el) => el.textContent === text,
      ) as HTMLElement;
    return { ...result, onChange, input, label };
  }

  test('lifts the entry into the input and takes it off the row', () => {
    const { input, label, container } = renderEditable(['blog', 'docs/**']);
    fireEvent.doubleClick(label('blog'));
    expect(input.value).toBe('blog');
    expect(container.textContent).not.toMatch(/blog(?!\/)/);
    expect(document.activeElement).toBe(input);
  });

  test('commits in place so the entry keeps its position', () => {
    const { input, label, onChange } = renderEditable(['blog', '!blog/drafts/**', 'docs/**']);
    fireEvent.doubleClick(label('blog'));
    fireEvent.change(input, { target: { value: 'blog/**' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['blog/**', '!blog/drafts/**', 'docs/**']);
  });

  test('Escape abandons the edit and restores the entry untouched', () => {
    const { input, label, onChange, container } = renderEditable(['blog']);
    fireEvent.doubleClick(label('blog'));
    fireEvent.change(input, { target: { value: 'blo' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(container.textContent).toContain('blog');
  });

  test('clearing the text and committing deletes the entry', () => {
    const { input, label, onChange } = renderEditable(['blog', 'docs/**']);
    fireEvent.doubleClick(label('blog'));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['docs/**']);
  });

  test('Backspace on an emptied edit box does not also eat the previous entry', () => {
    const { input, label, onChange } = renderEditable(['blog', 'docs/**']);
    fireEvent.doubleClick(label('docs/**'));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('blur commits the edit', () => {
    const { input, label, onChange } = renderEditable(['blog']);
    fireEvent.doubleClick(label('blog'));
    fireEvent.change(input, { target: { value: 'blog/**' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['blog/**']);
  });

  test('blur on an emptied edit box deletes the entry', () => {
    const { input, label, onChange } = renderEditable(['blog', 'docs/**']);
    fireEvent.doubleClick(label('blog'));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['docs/**']);
  });

  test('editing an entry into another entry collapses the pair', () => {
    const { input, label, onChange } = renderEditable(['blog', 'docs/**']);
    fireEvent.doubleClick(label('blog'));
    fireEvent.change(input, { target: { value: 'docs/**' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['docs/**']);
  });

  test('a draft in flight is committed rather than dropped when a pill is double-clicked', () => {
    const { input, label, onChange } = renderEditable(['blog']);
    fireEvent.change(input, { target: { value: 'specs/**' } });
    fireEvent.doubleClick(label('blog'));
    expect(onChange).toHaveBeenCalledWith(['blog', 'specs/**']);
    expect(input.value).toBe('blog');
  });

  test('ArrowLeft then Enter reaches the same edit from the keyboard', () => {
    const { input } = renderEditable(['blog', 'docs/**']);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('blog');
    expect(document.activeElement).toBe(input);
  });

  test('Space activates the edit on a highlighted entry (keyboard parity with Enter)', () => {
    const { input } = renderEditable(['blog', 'docs/**']);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: ' ' });
    expect(input.value).toBe('blog');
    expect(document.activeElement).toBe(input);
  });

  test('the pill label carries an accessible name naming the action', () => {
    const { label } = renderEditable(['blog']);
    expect(label('blog').getAttribute('aria-label')).toBe('Edit blog');
  });

  test('double-click is inert while disabled', () => {
    const { container } = render(
      <TooltipProvider>
        <TagPillInput value={['blog']} onChange={() => {}} grammar="free-text" disabled />
      </TooltipProvider>,
    );
    const label = container.querySelector('[data-slot="badge"] button') as HTMLElement;
    fireEvent.doubleClick(label);
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('');
  });
});

describe('TagPillInput — roving highlight', () => {
  afterEach(() => {
    cleanup();
  });

  function renderRoving(value: string[], onChange = vi.fn(() => {})) {
    const result = render(
      <TooltipProvider>
        <TagPillInput value={value} onChange={onChange} grammar="free-text" id="globs" />
      </TooltipProvider>,
    );
    const input = result.container.querySelector('input') as HTMLInputElement;
    const highlighted = () => result.container.querySelector('[data-highlighted="true"]');
    return { ...result, onChange, input, highlighted };
  }

  test('entries are not tab stops — the pill label is removed from the tab order', () => {
    const { container } = renderRoving(['a', 'b', 'c']);
    const labels = [...container.querySelectorAll('[data-slot="badge"] button')].filter(
      (el) => el.textContent !== '',
    );
    expect(labels).toHaveLength(3);
    for (const label of labels) expect(label.getAttribute('tabindex')).toBe('-1');
  });

  test('ArrowLeft at the start of the input highlights the last entry', () => {
    const { input, highlighted } = renderRoving(['a', 'b']);
    expect(highlighted()).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(highlighted()?.textContent).toContain('b');
  });

  test('ArrowLeft does not leave the text while the caret is mid-draft', () => {
    const { input, highlighted } = renderRoving(['a']);
    fireEvent.change(input, { target: { value: 'draft' } });
    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(highlighted()).toBeNull();
  });

  test('Left and Right walk the highlight, and Right past the end returns to the input', () => {
    const { input, highlighted } = renderRoving(['a', 'b', 'c']);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(highlighted()?.textContent).toContain('c');
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(highlighted()?.textContent).toContain('b');
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(highlighted()?.textContent).toContain('c');
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(highlighted()).toBeNull();
  });

  test('Home and End jump the highlight to the ends', () => {
    const { input, highlighted } = renderRoving(['a', 'b', 'c']);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'Home' });
    expect(highlighted()?.textContent).toContain('a');
    fireEvent.keyDown(input, { key: 'End' });
    expect(highlighted()?.textContent).toContain('c');
  });

  test('the highlight is reported through aria-activedescendant', () => {
    const { input, highlighted } = renderRoving(['a', 'b']);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(input.getAttribute('aria-activedescendant')).toBe(highlighted()?.id);
  });

  test('Backspace removes the highlighted entry and steps backward', () => {
    const { input, onChange, highlighted } = renderRoving(['a', 'b', 'c']);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
    expect(highlighted()?.textContent).toContain('a');
  });

  test('Delete removes the highlighted entry and steps forward', () => {
    const { input, onChange, highlighted } = renderRoving(['a', 'b', 'c']);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'Delete' });
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
    expect(highlighted()?.textContent).toContain('c');
  });

  test('Backspace with nothing highlighted still removes the last entry', () => {
    const { input, onChange } = renderRoving(['a', 'b']);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  test('Escape and typing both drop the highlight', () => {
    const { input, highlighted } = renderRoving(['a', 'b']);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(highlighted()).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(highlighted()).not.toBeNull();
    fireEvent.change(input, { target: { value: 'x' } });
    expect(highlighted()).toBeNull();
  });

  test('no highlight is reachable in an empty list', () => {
    const { input, highlighted } = renderRoving([]);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(highlighted()).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });
});

describe('TagPillInput — abandoning an edit', () => {
  afterEach(() => {
    cleanup();
  });

  test('a blur that fails the grammar gate returns the entry to the row', () => {
    const onChange = vi.fn(() => {});
    const { container } = render(
      <TooltipProvider>
        <TagPillInput value={['keeper']} onChange={onChange} />
      </TooltipProvider>,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    const label = [...container.querySelectorAll('[data-slot="badge"] button')].find(
      (el) => el.textContent === 'keeper',
    ) as HTMLElement;

    fireEvent.doubleClick(label);
    expect(input.value).toBe('keeper');
    fireEvent.change(input, { target: { value: 'has spaces' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('keeper');
  });

  test('Escape with only a highlight active keeps the typed draft', () => {
    const { input, highlighted } = (() => {
      const result = render(
        <TooltipProvider>
          <TagPillInput value={['a', 'b']} onChange={() => {}} grammar="free-text" />
        </TooltipProvider>,
      );
      const el = result.container.querySelector('input') as HTMLInputElement;
      return {
        input: el,
        highlighted: () => result.container.querySelector('[data-highlighted="true"]'),
      };
    })();

    fireEvent.change(input, { target: { value: 'spec' } });
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(highlighted()).not.toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(highlighted()).toBeNull();
    expect(input.value).toBe('spec');
  });

  test('Escape during a real edit still abandons it', () => {
    const { input, container } = (() => {
      const result = render(
        <TooltipProvider>
          <TagPillInput value={['blog']} onChange={() => {}} grammar="free-text" />
        </TooltipProvider>,
      );
      return {
        input: result.container.querySelector('input') as HTMLInputElement,
        container: result.container,
      };
    })();
    const label = [...container.querySelectorAll('[data-slot="badge"] button')].find(
      (el) => el.textContent === 'blog',
    ) as HTMLElement;

    fireEvent.doubleClick(label);
    fireEvent.change(input, { target: { value: 'blo' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(container.textContent).toContain('blog');
  });
});
