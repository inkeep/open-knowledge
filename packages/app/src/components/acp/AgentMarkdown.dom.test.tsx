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
    const table = render(<AgentMarkdown text={'| a | b |\n| - | - |\n| 1 | 2 |'} />);
    expect(table.container.querySelector('table')).not.toBeNull();

    const strike = render(<AgentMarkdown text={'~~gone~~'} />);
    expect(strike.container.querySelector('del')).not.toBeNull();
  });
});

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
    const { container } = renderWithResolver('see `notes/@team.md` for the roster');
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/notes/%40team');
    expect(link?.getAttribute('title')).toBe('Open notes/@team');
  });

  test('the tooltip decodes the escapes in a hash the agent wrote itself', () => {
    const { container } = renderWithResolver('[My Notes](#/My%20Notes)');
    const link = container.querySelector('a[data-testid="agent-thread-doc-link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#/My%20Notes');
    expect(link?.getAttribute('title')).toBe('Open My Notes');
  });

  test('a hash the reader cannot parse leaves the tooltip showing the raw href', () => {
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
    expect(link?.getAttribute('class')).toContain('underline');
    expect(link?.getAttribute('class')).toContain('text-primary');
    expect(link?.getAttribute('data-streamdown')).toBe('link');
  });
});
