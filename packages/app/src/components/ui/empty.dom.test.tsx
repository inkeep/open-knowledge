/**
 * DOM-substrate tests for the Empty layout primitive. Call sites style
 * themselves through `className` and identify their parts through `data-slot`,
 * so those two are the primitive's whole contract; the `asChild` title is the
 * one place we diverge from upstream and therefore the one place a silent
 * regression would go unnoticed.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './empty';

afterEach(cleanup);

function slot(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!found) throw new Error(`no element with data-slot="${name}"`);
  return found;
}

describe('Empty', () => {
  test('renders every part under its own slot, nested as composed', () => {
    const { container } = render(
      <Empty>
        <EmptyMedia variant="icon">
          <svg aria-hidden="true" />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Nothing here</EmptyTitle>
          <EmptyDescription>Add something to get started.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <span>action</span>
        </EmptyContent>
      </Empty>,
    );

    const root = slot(container, 'empty');
    for (const name of ['empty-icon', 'empty-header', 'empty-title', 'empty-description']) {
      expect(root.contains(slot(container, name))).toBe(true);
    }
    expect(slot(container, 'empty-header').contains(slot(container, 'empty-title'))).toBe(true);
    expect(screen.getByText('Nothing here')).toBeTruthy();
    expect(screen.getByText('Add something to get started.')).toBeTruthy();
  });

  test('caller className composes with the base classes rather than replacing them', () => {
    const { container } = render(<Empty className="h-full gap-8">empty</Empty>);

    expectVisualClassTokens(slot(container, 'empty').getAttribute('class'), [
      'flex-col',
      'items-center',
      'justify-center',
      'h-full',
      'gap-8',
    ]);
  });

  test('conflicting caller utilities win over the base classes', () => {
    const { container } = render(<Empty className="gap-8 p-8">empty</Empty>);

    const className = slot(container, 'empty').getAttribute('class') ?? '';
    expect(className).not.toContain('gap-4');
    expect(className).not.toContain('p-6');
  });

  // The merge only resolves within a class group, and px/py do not supersede p.
  // A call site that spells its padding override in longhand alone leaves the
  // base p-6 in the class list and hands the outcome to Tailwind's stylesheet
  // order instead. Lead with a shorthand and the base is actually displaced.
  test('replacing the root padding needs a shorthand, not longhand alone', () => {
    const { container: longhandOnly } = render(<Empty className="px-0 py-8">empty</Empty>);
    expect(slot(longhandOnly, 'empty').getAttribute('class')).toContain('p-6');

    cleanup();

    const { container: withShorthand } = render(<Empty className="p-0 py-8">empty</Empty>);
    const className = slot(withShorthand, 'empty').getAttribute('class') ?? '';
    expect(className).not.toContain('p-6');
    expectVisualClassTokens(className, ['p-0', 'py-8']);
  });

  test('caller props override the primitive defaults, including its own slot', () => {
    render(
      <Empty role="status" aria-label="Nothing to show" data-slot="large-file-editor-state">
        empty
      </Empty>,
    );

    const root = screen.getByRole('status');
    expect(root.getAttribute('data-slot')).toBe('large-file-editor-state');
    expect(root.getAttribute('aria-label')).toBe('Nothing to show');
  });

  test('media records its variant so call sites can target the icon treatment', () => {
    const { container: iconVariant } = render(
      <EmptyMedia variant="icon">
        <svg aria-hidden="true" />
      </EmptyMedia>,
    );
    expect(slot(iconVariant, 'empty-icon').getAttribute('data-variant')).toBe('icon');

    cleanup();

    const { container: defaultVariant } = render(
      <EmptyMedia>
        <svg aria-hidden="true" />
      </EmptyMedia>,
    );
    expect(slot(defaultVariant, 'empty-icon').getAttribute('data-variant')).toBe('default');
  });
});

describe('EmptyTitle', () => {
  test('renders a plain container by default', () => {
    const { container } = render(<EmptyTitle>Nothing here</EmptyTitle>);

    expect(slot(container, 'empty-title').tagName).toBe('DIV');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  test('asChild keeps the caller element, so a heading stays a heading', () => {
    const { container } = render(
      <EmptyTitle asChild>
        <h2>Nothing here</h2>
      </EmptyTitle>,
    );

    const title = slot(container, 'empty-title');
    expect(title.tagName).toBe('H2');
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBe(title);
  });

  test('asChild forwards the caller attributes needed to label and focus the title', () => {
    render(
      <EmptyTitle asChild>
        <h2 id="empty-title-probe" tabIndex={-1}>
          Nothing here
        </h2>
      </EmptyTitle>,
    );

    const heading = screen.getByRole('heading', { name: 'Nothing here' });
    expect(heading.id).toBe('empty-title-probe');
    heading.focus();
    expect(document.activeElement).toBe(heading);
  });

  test('asChild still merges the title className, so caller sizing wins', () => {
    const { container } = render(
      <EmptyTitle asChild className="text-2xl font-light">
        <h2>Nothing here</h2>
      </EmptyTitle>,
    );

    const className = slot(container, 'empty-title').getAttribute('class') ?? '';
    // The merge has to resolve conflicts, not concatenate: Tailwind's own
    // stylesheet order would otherwise let the primitive's font-medium beat the
    // caller's font-light regardless of which class is written last.
    expect(className).not.toContain('text-sm');
    expect(className).not.toContain('font-medium');
    expectVisualClassTokens(className, ['text-2xl', 'font-light', 'tracking-tight']);
  });
});
