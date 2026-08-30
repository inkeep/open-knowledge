/**
 * RTL mount tests for AgentMarkdown: streamed ACP agent text renders as
 * markdown (not raw source), incomplete mid-stream constructs display
 * without leaking delimiter syntax, raw HTML from the agent is sanitized,
 * and links are hardened against opener hijacking. Invocation via
 * `bun run test:dom`.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { Workspace } from '@/lib/workspace-paths';
import { AgentMarkdown } from './AgentMarkdown';
import { buildDocPathResolver, setDocPathResolver } from './doc-path-links';
import { DocPathResolverReadyContext } from './doc-path-links-context';

describe('AgentMarkdown', () => {
  afterEach(cleanup);

  test('renders emphasis and inline code as elements, not raw delimiters', () => {
    const { container } = render(<AgentMarkdown text={'**bold** and `inline`'} />);
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('inline');
    expect(container.textContent).not.toContain('**');
  });

  test('renders fenced code blocks', async () => {
    const { container } = render(<AgentMarkdown text={'```ts\nconst x = 1;\n```'} />);
    await waitFor(() => {
      expect(container.querySelector('pre')?.textContent).toContain('const x = 1;');
    });
  });

  test('code blocks keep one wrapper span per line', async () => {
    // AgentMarkdown's `[&_pre_code>span]:block` rule is what stacks code
    // lines when line numbers are off — Streamdown only applies per-line
    // block display through its line-number classes. This pins the DOM
    // shape that rule targets; if a Streamdown upgrade changes it,
    // multi-line code silently collapses onto one visual line.
    const { container } = render(
      <AgentMarkdown text={'```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```'} />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('pre code > span')).toHaveLength(3);
    });
  });

  test('renders lists and headings structurally', () => {
    const { container } = render(<AgentMarkdown text={'## Title\n\n- one\n- two'} />);
    expect(container.querySelector('h2')?.textContent).toBe('Title');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  test('an unterminated construct mid-stream shows text without delimiter noise', () => {
    const { container } = render(<AgentMarkdown text={'streaming **partial'} />);
    expect(container.textContent).toContain('partial');
    expect(container.textContent).not.toContain('**');
  });

  test('sanitizes raw HTML from the agent', () => {
    const { container } = render(
      <AgentMarkdown text={'before <img src="x" onerror="window.__pwned = true"> after'} />,
    );
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('onerror')).toBeNull();
    }
    expect(container.querySelector('script')).toBeNull();
  });

  test('hardens links to open in a new context', () => {
    const { container } = render(<AgentMarkdown text={'[docs](https://example.com/)'} />);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toContain('noreferrer');
  });
});

/**
 * A lone newline ends the line.
 *
 * Markdown collapses one into a space; only a blank line starts a block. That is
 * right for prose and wrong for a chat transcript, where people press Enter once
 * — and it started mattering when sent messages began rendering as markdown
 * instead of printing verbatim under `whitespace-pre-wrap`.
 */
describe('single newlines', () => {
  test('become a line break', () => {
    const { container } = render(<AgentMarkdown text={'first line\nsecond line'} />);
    expect(container.querySelector('br')).not.toBeNull();
  });

  test('leave fenced code alone — its newlines are the code renderer’s', () => {
    const { container } = render(<AgentMarkdown text={'```ts\nconst a = 1;\nconst b = 2;\n```'} />);
    expect(container.querySelector('pre br')).toBeNull();
  });

  test('do not cost the renderer its GFM defaults', () => {
    // The break rule arrives via `remarkPlugins`, which REPLACES Streamdown's
    // own set rather than extending it. Passing the plugin alone dropped
    // remark-gfm with it, and the damage showed up in agent output far from the
    // line that caused it — so both of these are the regression guard.
    const table = render(<AgentMarkdown text={'| a | b |\n| - | - |\n| 1 | 2 |'} />);
    expect(table.container.querySelector('table')).not.toBeNull();

    const strike = render(<AgentMarkdown text={'~~gone~~'} />);
    expect(strike.container.querySelector('del')).not.toBeNull();
  });
});

// The doc-path-links block. `AgentMarkdown` reads a `DocPathResolverReady`
// context to decide whether to key its Streamdown for the resolver-available
// render, so we wrap the render tree in the provider and populate the
// module-scoped `currentResolver` directly (ThreadView owns those writes in
// production). This isolates the feature under test without pulling in a
// PageList provider tree.
const workspace: Workspace = {
  contentDir: '/Users/abraham/repo/public/open-knowledge',
  pathSeparator: '/',
};
const pages = new Set(['reports/foo/REPORT', 'notes/haiku', 'notes/@team']);

function renderWithResolver(text: string) {
  const resolver = buildDocPathResolver({ workspace, pages });
  setDocPathResolver(resolver);
  return render(
    <DocPathResolverReadyContext value={resolver !== null}>
      <AgentMarkdown text={text} />
    </DocPathResolverReadyContext>,
  );
}

describe('AgentMarkdown doc-path links', () => {
  afterEach(() => {
    cleanup();
    setDocPathResolver(null);
  });

  test('a repo-root-relative .md path in prose renders as an in-app hash link', () => {
    const { container } = renderWithResolver(
      'Written to public/open-knowledge/reports/foo/REPORT.md (458 lines)',
    );
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/reports/foo/REPORT');
    // No target=_blank — in-app hash router, not external.
    expect(link?.getAttribute('target')).toBeNull();
    expect(link?.textContent).toContain('public/open-knowledge/reports/foo/REPORT.md');
  });

  test('a backticked path resolves too — the mono styling survives the wrap', () => {
    const { container } = renderWithResolver('see `notes/haiku.md` for the poem');
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/notes/haiku');
    expect(link?.querySelector('code')?.textContent).toBe('notes/haiku.md');
  });

  test('a resolved path whose name needs escaping keeps the tooltip readable', () => {
    // `DOC_PATH_REGEX` admits `@`, and `encodeURIComponent` escapes it to
    // `%40`, so the resolver's own output is enough to reach the escaped case
    // — the one shape in this suite where the href and the name differ.
    const { container } = renderWithResolver('see `notes/@team.md` for the roster');
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/notes/%40team');
    expect(link?.getAttribute('title')).toBe('Open notes/@team');
  });

  test('the tooltip decodes the escapes in a hash the agent wrote itself', () => {
    // The other way in: any `#/` link in agent markdown reaches this anchor,
    // and a space is the common case the resolver cannot produce, since
    // `DOC_PATH_REGEX` does not match one. A reader that does not decode shows
    // the user `Open My%20Notes` instead of the name they know.
    const { container } = renderWithResolver('[My Notes](#/My%20Notes)');
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/My%20Notes');
    expect(link?.getAttribute('title')).toBe('Open My Notes');
  });

  test('a hash the reader cannot parse leaves the tooltip showing the raw href', () => {
    // The `?? href` fallback. `#/` alone has no doc name to decode, and the
    // tooltip has to say something.
    const { container } = renderWithResolver('[home](#/)');
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link?.getAttribute('title')).toBe('Open #/');
  });

  test('an unresolvable path stays plain text — no link, no create-on-open trap', () => {
    const { container } = renderWithResolver('wrote reports/DOES-NOT-EXIST.md just now');
    expect(container.querySelector('a[data-testid="agent-thread-doc-link"]')).toBeNull();
    expect(container.textContent).toContain('reports/DOES-NOT-EXIST.md');
  });

  test('paths become links when the resolver flips null → ready — the cold-page-load path', async () => {
    // Every other test in this suite mounts with the resolver already ready.
    // The `key` on Streamdown exists specifically for the transition case —
    // Streamdown caches its per-Block processor at first mount and never
    // re-parses when a later render passes a different plugin closure, so a
    // regression that swapped the key values or dropped context propagation
    // would leave every message rendered during the cold-page-load window
    // showing dead paths for the entire session.
    setDocPathResolver(null);
    const text = 'see reports/foo/REPORT.md please';
    const { container, rerender } = render(
      <DocPathResolverReadyContext value={false}>
        <AgentMarkdown text={text} />
      </DocPathResolverReadyContext>,
    );
    expect(container.querySelector('a[data-testid="agent-thread-doc-link"]')).toBeNull();

    const resolver = buildDocPathResolver({ workspace, pages });
    setDocPathResolver(resolver);
    rerender(
      <DocPathResolverReadyContext value={resolver !== null}>
        <AgentMarkdown text={text} />
      </DocPathResolverReadyContext>,
    );
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/reports/foo/REPORT');
  });

  test('an .mdx path renders as an in-app link — the docs site is a Fumadocs .mdx tree', () => {
    // The mocked page set in renderWithResolver only includes .md docs, so
    // build a fresh render with a page set that has an .mdx target.
    const resolver = buildDocPathResolver({
      workspace,
      pages: new Set(['docs/intro']),
    });
    setDocPathResolver(resolver);
    const { container } = render(
      <DocPathResolverReadyContext value={resolver !== null}>
        <AgentMarkdown text={'open docs/intro.mdx for the setup steps'} />
      </DocPathResolverReadyContext>,
    );
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/docs/intro');
    expect(link?.textContent).toBe('docs/intro.mdx');
  });

  test('an external link keeps target=_blank + Streamdown link styling', () => {
    const { container } = renderWithResolver('see [docs](https://example.com/x)');
    const link = container.querySelector('a[href="https://example.com/x"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
    // Overriding components.a replaces Streamdown's MarkdownA — the external
    // branch has to keep the same class list so external links stay visible.
    expect(link?.getAttribute('class')).toContain('underline');
    expect(link?.getAttribute('class')).toContain('text-primary');
    expect(link?.getAttribute('data-streamdown')).toBe('link');
  });
});
