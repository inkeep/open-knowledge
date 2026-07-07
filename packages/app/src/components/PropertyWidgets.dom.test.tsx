/**
 * DOM-substrate tests for the WYSIWYG grammar gate on the `tags`
 * frontmatter field. Runs under `bun run test:dom` (jsdom + RTL).
 *
 * Covers the observable behaviors migrated off `?raw` source-text
 * guards: never assert raw source text for JSX / classes / imports /
 * hooks / props.
 * Runtime coverage IS possible here because `ListWidget` is a regular
 * exported component with no Y.Doc / collab dependency at the widget
 * boundary — feed it `value` + an `onCommit` spy and the grammar gate
 * becomes a pure-React assertion.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ListWidget, TextWidget } from './PropertyWidgets';

function renderWidget(opts: {
  keyName: string;
  value: string[];
  onCommit?: (next: string[]) => void;
}) {
  const onCommit = opts.onCommit ?? mock(() => {});
  // TooltipProvider wraps the tree because invalid tag chips render
  // inside a Radix Tooltip — production has a root provider; test
  // substrate has to opt in.
  const result = render(
    <TooltipProvider>
      <ListWidget keyName={opts.keyName} value={opts.value} onCommit={onCommit} />
    </TooltipProvider>,
  );
  return { ...result, onCommit };
}

describe('ListWidget — render-side invalid tag flagging', () => {
  afterEach(() => {
    cleanup();
  });

  test('seed of mixed valid + invalid tags yields the right chip count + invalid flags', () => {
    // Source-mode authoring lets arbitrary YAML through; ListWidget
    // receives the raw string array and per-chip-flags entries that
    // fail the grammar gate so authors can spot + fix them without
    // context-switching.
    const { container } = renderWidget({
      keyName: 'tags',
      value: ['showcase', '2026', 'has spaces', 'proj/team', 'hello!'],
    });
    const chips = container.querySelectorAll('[data-testid="list-chip"]');
    expect(chips).toHaveLength(5);
    const invalid = container.querySelectorAll('[data-tag-invalid="true"]');
    // Two invalid: whitespace `has spaces`, special-char `hello!`. The
    // digit-leading `2026` is a valid frontmatter tag (a year), so it is
    // NOT flagged.
    expect(invalid).toHaveLength(2);
    const invalidTexts = Array.from(invalid).map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(invalidTexts.some((t) => t.includes('2026'))).toBe(false);
    expect(invalidTexts.some((t) => t.includes('has spaces'))).toBe(true);
    expect(invalidTexts.some((t) => t.includes('hello!'))).toBe(true);
  });

  test('a non-tag list field (categories, aliases, …) never flags chips as invalid', () => {
    // The grammar gate is scoped to `keyName === 'tags'` — other list
    // fields keep their free-form rendering. Pin so a future refactor
    // that drops the `isTagsField` guard surfaces here.
    const { container } = renderWidget({
      keyName: 'aliases',
      value: ['has spaces', '2026', 'hello!'],
    });
    expect(container.querySelectorAll('[data-tag-invalid="true"]')).toHaveLength(0);
  });

  test('invalid chips are wrapped in a Radix Tooltip trigger (content lazy-renders on open)', () => {
    // Radix Tooltip lazy-mounts content on first open — pre-open the
    // DOM only carries the trigger. Asserting on `data-slot=
    // "tooltip-trigger"` proves the wrapping happened; the content
    // copy is pinned in the parallel input-rejection test
    // (where the inline `role="alert"` helper is non-lazy).
    const { container } = renderWidget({ keyName: 'tags', value: ['bad!'] });
    const invalidChip = container.querySelector('[data-tag-invalid="true"]');
    expect(invalidChip?.getAttribute('data-slot')).toBe('tooltip-trigger');
  });

  test('valid tag chips are NOT wrapped in a Tooltip (tooltip is diagnostic-only)', () => {
    // The destructive ring + tooltip is reserved for invalid chips.
    // Valid + non-tag list values get no extra DOM ceremony.
    const { container } = renderWidget({ keyName: 'tags', value: ['showcase'] });
    const chip = container.querySelector('[data-testid="list-chip"]');
    expect(chip?.getAttribute('data-slot')).not.toBe('tooltip-trigger');
  });

  test('valid tags render as `#tag` clickable buttons (unchanged from pre-PR behavior)', () => {
    const { container } = renderWidget({ keyName: 'tags', value: ['showcase'] });
    const tagBtn = container.querySelector('button[data-tag="showcase"]');
    expect(tagBtn).not.toBeNull();
    expect(tagBtn?.textContent).toBe('#showcase');
  });
});

describe('ListWidget — input-side grammar gate (tags field only)', () => {
  afterEach(() => {
    cleanup();
  });

  test('addChip rejects invalid input on Enter — no onCommit fires; draft persists', () => {
    const onCommit = mock(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Did NOT commit.
    expect(onCommit).toHaveBeenCalledTimes(0);
    // Draft retained so the author can correct in place.
    expect(input.value).toBe('bad!');
    // Rejection state surfaces on the input + the role="alert" helper.
    expect(input.getAttribute('data-tag-invalid')).toBe('true');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = container.querySelector('[data-testid="list-chip-input-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Tags must start with a letter');
  });

  test('addChip accepts a valid tag on Enter — commits + clears draft + no rejection state', () => {
    const onCommit = mock(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['showcase']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(container.querySelector('[data-testid="list-chip-input-error"]')).toBeNull();
  });

  test('addChip accepts a digit-leading tag like a year (2026)', () => {
    // Digit-leading tags are valid in frontmatter even though the inline
    // `#tag` surface rejects them — a year is a legitimate tag.
    const onCommit = mock(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['2026']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('typing after a rejection clears the rejection state immediately', () => {
    // Author is correcting — destructive affordances vanish on the next
    // keystroke so they get fresh feedback on the next commit attempt.
    const { container } = renderWidget({ keyName: 'tags', value: [] });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: 'bad!x' } });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(container.querySelector('[data-testid="list-chip-input-error"]')).toBeNull();
  });

  test('Escape clears rejection state without committing', () => {
    const onCommit = mock(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad!' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(0);
  });

  test('input strips leading `#` before commit (Obsidian-shape paste tolerance)', () => {
    // The grammar helper strips a single leading `#` for paste tolerance,
    // so `#showcase` passes the gate — but the committed value must be
    // canonical bare `showcase`. Without this normalization the chip
    // would either render as invalid on the next paint (renderer's
    // `FRONTMATTER_TAG_VALUE_RE` rejects bare `#`) or silently re-
    // normalize on the next on-disk YAML round-trip.
    const onCommit = mock(() => {});
    const { container } = renderWidget({ keyName: 'tags', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#showcase' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['showcase']);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('a non-tag list field preserves a leading `#` (no tags-specific normalization)', () => {
    // Generic list fields (`aliases`, `categories`, …) commit values
    // verbatim — the `#`-strip is scoped to `isTagsField` since
    // other fields don't share the tag grammar's tolerance.
    const onCommit = mock(() => {});
    const { container } = renderWidget({ keyName: 'aliases', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#literal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['#literal']);
  });

  test('a non-tag list field commits any string — grammar gate stays scoped', () => {
    const onCommit = mock(() => {});
    const { container } = renderWidget({ keyName: 'aliases', value: [], onCommit });
    const input = container.querySelector('[data-testid="list-chip-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toEqual(['2026']);
    expect(input.value).toBe('');
  });
});

// ---------------------------------------------------------------------
// TextWidget — link-mode rendering (URL-shaped values flip to a clickable
// `<a>` view; empty / non-URL / relative values fall through to the
// textarea view as plain text).
// ---------------------------------------------------------------------
function renderTextWidget(opts: {
  keyName: string;
  value: string;
  onCommit?: (next: string) => void;
}) {
  const onCommit = opts.onCommit ?? mock(() => {});
  const result = render(
    <TooltipProvider>
      <TextWidget keyName={opts.keyName} value={opts.value} onCommit={onCommit} />
    </TooltipProvider>,
  );
  return { ...result, onCommit };
}

describe('TextWidget — link-mode predicate', () => {
  afterEach(() => {
    cleanup();
  });

  test('http URL renders as link-widget with correct href + aria-label', () => {
    const { container } = renderTextWidget({
      keyName: 'linear',
      value: 'https://linear.app/inkeep/issue/PRD-6781',
    });
    const link = container.querySelector('[data-testid="link-widget"]');
    expect(link).not.toBeNull();
    const anchor = link?.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://linear.app/inkeep/issue/PRD-6781');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor?.getAttribute('aria-label')).toBe('Open linear in browser');
    // No textarea in link view.
    expect(container.querySelector('[data-testid="text-widget"]')).toBeNull();
  });

  test('https URL with mixed case is still recognized (regex is /^https?:\\/\\//i)', () => {
    const { container } = renderTextWidget({ keyName: 'site', value: 'HTTPS://example.com' });
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
  });

  test('empty string renders as text-widget, NOT link-widget (zero-width chip bug guard)', () => {
    // Pre-fix: `isSafeUrl('')` returned `true`, so empty text properties
    // rendered as zero-width clickable chips with broken navigation. The
    // tightened predicate (`trimmed.length > 0 && /^https?:\/\//i`)
    // closes this regression.
    const { container } = renderTextWidget({ keyName: 'note', value: '' });
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test('whitespace-only value renders as text-widget (trim before scheme check)', () => {
    const { container } = renderTextWidget({ keyName: 'note', value: '   ' });
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test.each([
    ['relative path', '/abs/path'],
    ['relative sibling', './sib'],
    ['anchor', '#section'],
    ['query', '?q=1'],
    ['mailto scheme', 'mailto:user@example.com'],
    ['tel scheme', 'tel:+15551234567'],
    ['ftp scheme', 'ftp://files.example.com'],
    ['plain text', 'just some notes'],
  ])('non-http(s) value (%s = %s) renders as text-widget', (_label, value) => {
    // The pre-fix `isSafeUrl` predicate let these through, producing
    // chips whose click handlers either no-oped (Electron `openExternal`
    // allowlist rejection on `tel:` / `ftp:`) or opened blank tabs
    // (web `window.open('')`). Pin the tighter predicate so future
    // refactors can't widen it back.
    const { container } = renderTextWidget({ keyName: 'note', value });
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test('pencil click switches link view → textarea edit view', () => {
    const { container } = renderTextWidget({ keyName: 'site', value: 'https://example.com' });
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
    const pencil = container.querySelector('[data-testid="link-widget-edit"]') as HTMLButtonElement;
    expect(pencil).not.toBeNull();
    fireEvent.click(pencil);
    // After flipping to edit mode the link view is gone and the textarea
    // is mounted.
    expect(container.querySelector('[data-testid="link-widget"]')).toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).not.toBeNull();
  });

  test('textarea blur with URL value returns to link view', () => {
    const { container } = renderTextWidget({ keyName: 'site', value: 'https://example.com' });
    const pencil = container.querySelector('[data-testid="link-widget-edit"]') as HTMLButtonElement;
    fireEvent.click(pencil);
    const textarea = container.querySelector('[data-testid="text-widget"]') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    // Blur (no value change) — onBlur clears the in-edit flag, the next
    // render evaluates the predicate again and routes back to link view.
    fireEvent.blur(textarea);
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="text-widget"]')).toBeNull();
  });

  test('edit + change + blur commits the new URL value', () => {
    // Pins the data-flow path that the no-change blur test doesn't
    // exercise: if the `if (draft !== value) onCommit(draft)` branch were
    // accidentally reversed, the UI-transition tests would still pass but
    // edits would be silently discarded.
    const commits: string[] = [];
    const { container } = renderTextWidget({
      keyName: 'site',
      value: 'https://example.com',
      onCommit: (next) => commits.push(next),
    });
    const pencil = container.querySelector('[data-testid="link-widget-edit"]') as HTMLButtonElement;
    fireEvent.click(pencil);
    const textarea = container.querySelector('[data-testid="text-widget"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'https://updated.com' } });
    fireEvent.blur(textarea);
    expect(commits).toEqual(['https://updated.com']);
    expect(container.querySelector('[data-testid="link-widget"]')).not.toBeNull();
  });
});
