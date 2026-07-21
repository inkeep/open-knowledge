/**
 * RTL mount tests for AgentMarkdown: streamed ACP agent text renders as
 * markdown (not raw source), incomplete mid-stream constructs display
 * without leaking delimiter syntax, raw HTML from the agent is sanitized,
 * and links are hardened against opener hijacking. Invocation via
 * `bun run test:dom`.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { AgentMarkdown } from './AgentMarkdown';

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
