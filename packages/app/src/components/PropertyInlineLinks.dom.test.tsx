/**
 * DOM tests for `PropertyInlineLinks` — guards two behaviors that would
 * silently regress under a refactor:
 *
 *   1. Wikilink anchors point at the SPA's hash router (`#/<target>`), not
 *      at the URL `target` verbatim — without this, the navigation would
 *      land on the docs site / 404 instead of staying inside the editor.
 *   2. Plain text fast-path renders a single `<span>` with no link
 *      affordances and no test-id attribute, so the overwhelming majority
 *      of property values (which have no embedded link syntax) pay zero
 *      DOM cost beyond a bare text node.
 *
 * Repo convention (see `EditWithAiBubbleButton.dom.test.tsx`,
 * `tag-pill-input.dom.test.tsx`): no @testing-library/react interaction
 * helpers — assert through queries on the rendered DOM after `render`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { PropertyInlineLinks } from './PropertyInlineLinks';

afterEach(() => {
  cleanup();
});

describe('PropertyInlineLinks — wikilink rendering', () => {
  test('wikilink target lands on the SPA hash route', () => {
    render(<PropertyInlineLinks text="[[some/page]] — note" />);
    const a = screen.getByTestId('property-inline-wikilink') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('#/some/page');
    expect(a.getAttribute('data-target')).toBe('some/page');
    // Trailing prose preserves; reassembly is what makes round-trip work.
    expect(screen.getByTestId('property-inline-links').textContent).toBe('some/page — note');
  });

  test('wikilink with anchor encodes the anchor onto the hash', () => {
    render(<PropertyInlineLinks text="[[page#heading]]" />);
    const a = screen.getByTestId('property-inline-wikilink') as HTMLAnchorElement;
    // hashFromTarget URL-encodes each path segment, so the `#` separator
    // we add for the anchor must NOT itself be encoded — verify.
    expect(a.getAttribute('href')).toBe('#/page#heading');
  });

  test('wikilink with alias displays the alias as the visible label', () => {
    render(<PropertyInlineLinks text="[[some/page|Custom Label]]" />);
    const a = screen.getByTestId('property-inline-wikilink');
    expect(a.textContent).toBe('Custom Label');
    expect(a.getAttribute('data-target')).toBe('some/page');
  });

  test('wikilink path with `/` segments encodes each segment individually', () => {
    render(<PropertyInlineLinks text="[[a b/c d]]" />);
    const a = screen.getByTestId('property-inline-wikilink') as HTMLAnchorElement;
    // Each segment gets its own encodeURIComponent, so the `/` separator
    // stays literal but spaces become `%20`.
    expect(a.getAttribute('href')).toBe('#/a%20b/c%20d');
  });
});

describe('PropertyInlineLinks — markdown links and autolinks', () => {
  test('markdown link renders text as the visible label', () => {
    render(<PropertyInlineLinks text="see [the page](https://example.com) here" />);
    const a = screen.getByTestId('property-inline-link') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.textContent).toBe('the page');
    expect(screen.getByTestId('property-inline-links').textContent).toBe('see the page here');
  });

  test('bare http(s) URL renders as autolink showing the full URL', () => {
    render(<PropertyInlineLinks text="visit https://example.com today" />);
    const a = screen.getByTestId('property-inline-autolink') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.textContent).toBe('https://example.com');
  });
});

describe('PropertyInlineLinks — plain-text fast path', () => {
  test('plain text renders a single span with no link-component test-id', () => {
    const { container } = render(<PropertyInlineLinks text="just plain words" />);
    // `hasInlineLinks` returned false → component skipped the tokenizer
    // and emitted a single span. The outer test-id only mounts on the
    // tokenized path, so its absence is the proof we took the fast path.
    expect(screen.queryByTestId('property-inline-links')).toBeNull();
    expect(screen.queryByTestId('property-inline-wikilink')).toBeNull();
    expect(screen.queryByTestId('property-inline-link')).toBeNull();
    expect(screen.queryByTestId('property-inline-autolink')).toBeNull();
    expect(container.textContent).toBe('just plain words');
  });

  test('empty string renders an empty span', () => {
    const { container } = render(<PropertyInlineLinks text="" />);
    expect(container.textContent).toBe('');
  });

  test('text containing the substring `[[` but no wikilink → fast path', () => {
    // `[[]]` looks like a wikilink prefix but the tokenizer rejects
    // empty targets. `hasInlineLinks` matches the tokenizer's verdict,
    // so we still hit the fast path. Without this guard, the substring
    // probe alone would over-trigger the tokenized render for chips
    // that look link-shaped but aren't.
    const { container } = render(<PropertyInlineLinks text="literal [[]] sequence" />);
    expect(screen.queryByTestId('property-inline-links')).toBeNull();
    expect(container.textContent).toBe('literal [[]] sequence');
  });
});

describe('PropertyInlineLinks — mixed content', () => {
  test('PRD-7111 reported shape — wikilink + em-dash + parenthetical text', () => {
    const input =
      '[[public/open-knowledge/specs/2026-06-12-showall-truncation-ux/SPEC]] — which entries appear (cap), NOT horizontal density';
    render(<PropertyInlineLinks text={input} />);
    const a = screen.getByTestId('property-inline-wikilink');
    expect(a.textContent).toBe('public/open-knowledge/specs/2026-06-12-showall-truncation-ux/SPEC');
    // The rest of the chip renders as plain text — visible label is the
    // wikilink target followed by the trailing prose.
    expect(screen.getByTestId('property-inline-links').textContent).toBe(
      'public/open-knowledge/specs/2026-06-12-showall-truncation-ux/SPEC — which entries appear (cap), NOT horizontal density',
    );
  });

  test('mixed wikilink + markdown link + autolink in one string', () => {
    render(<PropertyInlineLinks text="see [[Page]] and [doc](./d.md) plus https://example.com" />);
    expect(screen.getByTestId('property-inline-wikilink').textContent).toBe('Page');
    expect(screen.getByTestId('property-inline-link').textContent).toBe('doc');
    expect(screen.getByTestId('property-inline-autolink').textContent).toBe('https://example.com');
  });
});
