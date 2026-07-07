/**
 * RTL behavioral tests for EditorBreadcrumb.
 *
 * Pins the rendered shape the source-grep `.test.ts` companion can't
 * cheaply assert: which segments render for which paths, that the
 * separator only appears BETWEEN segments (not before the first one),
 * that root-level docs render nothing, and that the per-segment title
 * tooltip carries the full segment text for truncation reveal.
 *
 * Exercises `render` under the jsdom substrate (precedent #43); invocation
 * via `bunx turbo run test:dom`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { EditorBreadcrumb } from './EditorBreadcrumb';

describe('EditorBreadcrumb (Tier-3 mount)', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders nothing for a null docName', () => {
    const { container } = render(<EditorBreadcrumb docName={null} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders nothing for a project-root docName (no folder prefix)', () => {
    const { container } = render(<EditorBreadcrumb docName="notes" />);
    expect(container.firstChild).toBeNull();
  });

  test('renders folder segments with chevron separators for a nested docName', () => {
    render(<EditorBreadcrumb docName="meetings/2026/q1/notes" />);

    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(nav).toBeTruthy();
    expectVisualClassTokens(nav.className, ['min-w-0']);

    // BreadcrumbItem nodes (one per folder segment) — gated by the shadcn
    // data-slot attribute so the BreadcrumbSeparator <li>s (which sit
    // between items) don't conflate the count.
    const itemEls = nav.querySelectorAll('li[data-slot="breadcrumb-item"]');
    expect(itemEls.length).toBe(3);
    expect(itemEls[0]?.textContent).toBe('meetings');
    expect(itemEls[1]?.textContent).toBe('2026');
    expect(itemEls[2]?.textContent).toBe('q1');

    // Separators: one BETWEEN every adjacent pair of segments, never
    // before the first. Both shadcn slots (separator + ellipsis-if-any)
    // carry aria-hidden, so counting separator <li>s directly is more
    // precise than counting all aria-hidden descendants.
    const separatorEls = nav.querySelectorAll('li[data-slot="breadcrumb-separator"]');
    expect(separatorEls.length).toBe(2);

    // Separator placement: the first DOM child of BreadcrumbList must be
    // a breadcrumb-item (the first segment), not a separator — pinning
    // "never before the first" structurally.
    const list = nav.querySelector('ol[data-slot="breadcrumb-list"]');
    expect(list?.firstElementChild?.getAttribute('data-slot')).toBe('breadcrumb-item');
    expectVisualClassTokens(list?.className, [
      'text-muted-foreground/70',
      'text-xs',
      'overflow-hidden',
    ]);
  });

  test('renders the basename folder for a one-deep docName', () => {
    render(<EditorBreadcrumb docName="meetings/notes" />);
    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    const itemEls = nav.querySelectorAll('li[data-slot="breadcrumb-item"]');
    expect(itemEls.length).toBe(1);
    expect(itemEls[0]?.textContent).toBe('meetings');
    // Single segment → zero separators.
    const separatorEls = nav.querySelectorAll('li[data-slot="breadcrumb-separator"]');
    expect(separatorEls.length).toBe(0);
  });

  test('exposes the full segment text via title for truncation reveal', () => {
    render(<EditorBreadcrumb docName="a-very-long-folder-name/another-folder/some-doc" />);
    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    const itemEls = Array.from(
      nav.querySelectorAll<HTMLLIElement>('li[data-slot="breadcrumb-item"]'),
    );
    // BreadcrumbPage forwards `title` onto its inner span via shadcn's
    // spread-props — the native truncation tooltip still works.
    const titleHosts = itemEls.map((li) => li.querySelector('[data-slot="breadcrumb-page"]'));
    expect(titleHosts[0]?.getAttribute('title')).toBe('a-very-long-folder-name');
    expect(titleHosts[1]?.getAttribute('title')).toBe('another-folder');
  });

  test('deep paths collapse middle segments into an accessible ellipsis', () => {
    render(<EditorBreadcrumb docName="one/two/three/four/five/six/notes" />);

    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    const itemEls = Array.from(
      nav.querySelectorAll<HTMLLIElement>('li[data-slot="breadcrumb-item"]'),
    );
    expect(itemEls.map((li) => li.textContent)).toEqual([
      'one',
      'two / three / four',
      'five',
      'six',
    ]);

    const ellipsis = itemEls[1];
    expect(ellipsis?.querySelector('[aria-hidden="true"]')?.getAttribute('title')).toBe(
      'two / three / four',
    );
    expect(ellipsis?.querySelector('.sr-only')?.textContent).toBe('two / three / four');
  });

  test('reactivity: changing docName re-renders with new segments', () => {
    const { rerender } = render(<EditorBreadcrumb docName="alpha/notes" />);
    let nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    let itemEls = nav.querySelectorAll('li[data-slot="breadcrumb-item"]');
    expect(Array.from(itemEls).map((li) => li.textContent)).toEqual(['alpha']);

    rerender(<EditorBreadcrumb docName="beta/gamma/notes" />);
    nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    itemEls = nav.querySelectorAll('li[data-slot="breadcrumb-item"]');
    expect(Array.from(itemEls).map((li) => li.textContent)).toEqual(['beta', 'gamma']);

    // Transition to root: breadcrumb disappears entirely.
    rerender(<EditorBreadcrumb docName="notes" />);
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).toBeNull();
  });

  test('emits no click/hover handlers — breadcrumb is pure display', () => {
    render(<EditorBreadcrumb docName="meetings/notes" />);
    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    // The whole component carries no onClick/onMouseEnter via DOM attrs.
    // BreadcrumbPage renders as a plain <span> (no role="link", no href,
    // no event handlers) — the WAI-ARIA APG breadcrumb pattern for
    // non-interactive items.
    expect(nav.tagName.toLowerCase()).toBe('nav');
    for (const li of nav.querySelectorAll('li[data-slot="breadcrumb-item"]')) {
      expect(li.tagName.toLowerCase()).toBe('li');
    }
    for (const span of nav.querySelectorAll('[data-slot="breadcrumb-page"]')) {
      expect(span.tagName.toLowerCase()).toBe('span');
      expect(span.getAttribute('href')).toBeNull();
      expect(span.getAttribute('role')).toBeNull();
    }
  });

  test('folder segments do not carry aria-current="page" — only the current page should', () => {
    // W3C APG breadcrumb pattern: exactly one element claims `aria-current="page"`.
    // EditorBreadcrumb shows folder context only (the current page's
    // basename is NOT rendered), so none of its segments are the current
    // page. Emitting `aria-current="page"` on every segment would cause
    // NVDA / VoiceOver to announce "current page" on every hierarchy
    // step, breaking orientation for AT users.
    render(<EditorBreadcrumb docName="meetings/2026/q1/notes" />);
    const nav = screen.getByRole('navigation', { name: /breadcrumb/i });
    const pages = nav.querySelectorAll('[data-slot="breadcrumb-page"]');
    expect(pages.length).toBe(3);
    for (const span of pages) {
      expect(span.getAttribute('aria-current')).toBeNull();
    }
  });
});
