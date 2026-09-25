import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { Workspace } from '@/lib/workspace-paths';
import { AgentMarkdown } from './AgentMarkdown';
import { buildDocPathResolver, setDocPathResolver } from './doc-path-links';
import { DocPathResolverReadyContext } from './doc-path-links-context';
import { ReferenceRulesContext } from './reference-links-context';

describe('AgentMarkdown', () => {
  afterEach(cleanup);

  test('renders emphasis and inline code as elements, not raw delimiters', () => {
    const { container } = render(<AgentMarkdown text={'**bold** and `inline`'} />);
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('inline');
    expect(container.textContent).not.toContain('**');
  });

  test('untrusted text renders no raw HTML element and loads no image', () => {
    const { container } = render(
      <AgentMarkdown text={'<b>bold</b> then ![a chart](https://example.com/x.png)'} untrusted />,
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('bold');
    expect(container.textContent).toContain('a chart');
  });

  test('a json fence from a tool result highlights as a code block and takes a className', async () => {
    const { container } = render(
      <AgentMarkdown text={'```json\n{\n  "ok": true\n}\n```'} className="tool-body" />,
    );
    expect(container.querySelector('.tool-body')).not.toBeNull();
    await waitFor(() => {
      expect(container.querySelector('pre')?.textContent).toContain('"ok": true');
    });
    expect(container.textContent).not.toContain('```');
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

  test('ticket prefixes and qualified GitHub references render as links that open outside, code does not', () => {
    const { container } = render(
      <ReferenceRulesContext
        value={{
          githubBase: 'https://github.com',
          autolinks: [{ prefix: 'PRD-', url: 'https://linear.app/inkeep/issue/PRD-<num>' }],
        }}
      >
        <AgentMarkdown
          text={'Fixes PRD-8223 and inkeep/agents-private#4971, not `PRD-1` or #12.'}
        />
      </ReferenceRulesContext>,
    );
    const anchors = [...container.querySelectorAll('a')].map((a) => [
      a.textContent,
      a.getAttribute('href'),
      a.getAttribute('target'),
    ]);
    expect(anchors).toEqual([
      ['PRD-8223', 'https://linear.app/inkeep/issue/PRD-8223', '_blank'],
      [
        'inkeep/agents-private#4971',
        'https://github.com/inkeep/agents-private/issues/4971',
        '_blank',
      ],
    ]);
  });

  test('each thread links references with its own GitHub host, whichever thread rendered last', () => {
    const enterprise = { githubBase: 'https://ghe.example.com', autolinks: [] };
    const dotcom = { githubBase: 'https://github.com', autolinks: [] };
    const hrefIn = (container: HTMLElement) => container.querySelector('a')?.getAttribute('href');
    const first = render(
      <ReferenceRulesContext value={enterprise}>
        <AgentMarkdown text="Fixed in team/repo#9." />
      </ReferenceRulesContext>,
    );
    const second = render(
      <ReferenceRulesContext value={dotcom}>
        <AgentMarkdown text="Fixed in team/repo#9." />
      </ReferenceRulesContext>,
    );
    first.rerender(
      <ReferenceRulesContext value={enterprise}>
        <AgentMarkdown text="Fixed in team/repo#10." />
      </ReferenceRulesContext>,
    );
    expect(hrefIn(first.container)).toBe('https://ghe.example.com/team/repo/issues/10');
    expect(hrefIn(second.container)).toBe('https://github.com/team/repo/issues/9');
  });

  test('references already on screen relink when the thread learns its GitHub host', () => {
    const text = 'Fixed in team/repo#9.';
    const { container, rerender } = render(
      <ReferenceRulesContext value={{ githubBase: 'https://github.com', autolinks: [] }}>
        <AgentMarkdown text={text} />
      </ReferenceRulesContext>,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/team/repo/issues/9',
    );
    rerender(
      <ReferenceRulesContext value={{ githubBase: 'https://ghe.example.com', autolinks: [] }}>
        <AgentMarkdown text={text} />
      </ReferenceRulesContext>,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://ghe.example.com/team/repo/issues/9',
    );
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

  test('a markdown link the agent wrote to a doc opens in-app instead of being blocked', () => {
    const { container } = renderWithResolver(
      'See [REPORT.md](public/open-knowledge/reports/foo/REPORT.md) for the findings.',
    );

    const anchor = container.querySelector('[data-testid="agent-thread-doc-link"]');
    expect(anchor?.getAttribute('href')).toBe('#/reports/foo/REPORT');
    expect(anchor?.textContent).toBe('REPORT.md');
    expect(container.textContent).not.toContain('[blocked]');
  });

  test('a section link written as ./path.md#slug, the form the project skill prescribes, opens the doc at that heading in-app', () => {
    const { container } = renderWithResolver(
      'The schema is under [Data model](./reports/foo/REPORT.md#data-model).',
    );

    const anchor = container.querySelector('[data-testid="agent-thread-doc-link"]');
    expect(anchor?.getAttribute('href')).toBe('#/reports/foo/REPORT#data-model');
    expect(anchor?.getAttribute('target')).toBeNull();
    expect(container.textContent).not.toContain('[blocked]');
  });

  test('a section link written as /path.md#slug, the content-root form, opens the doc at that heading in-app', () => {
    const { container } = renderWithResolver(
      'The schema is under [Data model](/reports/foo/REPORT.md#data-model).',
    );

    const anchor = container.querySelector('[data-testid="agent-thread-doc-link"]');
    expect(anchor?.getAttribute('href')).toBe('#/reports/foo/REPORT#data-model');
    expect(anchor?.getAttribute('target')).toBeNull();
  });

  test('a markdown link to a file: URL of a workspace doc opens in-app too', () => {
    const { container } = renderWithResolver(
      '[the report](file:///Users/abraham/repo/public/open-knowledge/reports/foo/REPORT.md)',
    );

    const anchor = container.querySelector('[data-testid="agent-thread-doc-link"]');
    expect(anchor?.getAttribute('href')).toBe('#/reports/foo/REPORT');
    expect(container.textContent).not.toContain('[blocked]');
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

  test('a reference-style link stays literal text — the renderer never joins a definition to its reference', () => {
    const { container } = renderWithResolver(
      'see [the report][r]\n\n[r]: public/open-knowledge/reports/foo/REPORT.md',
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[the report][r]');
  });

  test('a heading fragment on a doc link survives onto the in-app route', () => {
    const { container } = renderWithResolver(
      '[findings](public/open-knowledge/reports/foo/REPORT.md#findings)',
    );
    const anchor = container.querySelector('[data-testid="agent-thread-doc-link"]');
    expect(anchor?.getAttribute('href')).toBe('#/reports/foo/REPORT#findings');
  });

  test('a fragment on a prose or backticked path lands on the in-app route as well', () => {
    const { container } = renderWithResolver(
      'see public/open-knowledge/reports/foo/REPORT.md#findings and `reports/foo/REPORT.md#root-cause`',
    );
    const hrefs = Array.from(
      container.querySelectorAll('[data-testid="agent-thread-doc-link"]'),
      (a) => a.getAttribute('href'),
    );
    expect(hrefs).toEqual(['#/reports/foo/REPORT#findings', '#/reports/foo/REPORT#root-cause']);
    expect(container.textContent).toContain(
      'REPORT.md#findings and reports/foo/REPORT.md#root-cause',
    );
  });

  test('a javascript: href never renders as a link, percent-encoded or not', () => {
    for (const href of ['javascript:alert(1)', 'javascript%3Aalert(1)']) {
      const { container, unmount } = renderWithResolver(`[run](${href})`);
      expect(container.querySelector('a[href^="javascript"]'), href).toBeNull();
      expect(container.querySelector('[data-testid="agent-thread-doc-link"]'), href).toBeNull();
      unmount();
    }
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
