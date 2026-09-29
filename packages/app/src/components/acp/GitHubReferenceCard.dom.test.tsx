import type { GitHubReferencePreview } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentMarkdown } from './AgentMarkdown';
import { GitHubReferenceCard } from './GitHubReferenceCard';

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const OPEN_PULL: GitHubReferencePreview = {
  kind: 'pull',
  repo: 'inkeep/agents',
  number: 4979,
  title: 'Send text files from outside the project',
  author: 'octocat',
  createdAt: '2025-03-04T10:00:00Z',
  lifecycle: 'open',
  additions: 120,
  deletions: 30,
  status: {
    mergeQueue: { position: 2, state: 'AWAITING_CHECKS' },
    autoMerge: false,
    mergeState: 'BLOCKED',
    reviewDecision: 'APPROVED',
    checks: 'PENDING',
  },
};

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('GitHubReferenceCard', () => {
  test('an open pull request shows its repo, title, state, diff, queue status and author', () => {
    render(<GitHubReferenceCard preview={OPEN_PULL} />);
    const card = screen.getByTestId('github-reference-card');
    expect(card.textContent).toContain('inkeep/agents');
    expect(card.textContent).toContain('Mar 4, 2025');
    expect(card.textContent).toContain('Send text files from outside the project #4979');
    expect(screen.getByTestId('github-reference-state').textContent).toBe('Open');
    expect(screen.getByRole('img', { name: 'Lines changed: 120 added, 30 removed' })).toBeTruthy();
    expect(screen.getByTestId('github-reference-status').textContent).toBe('#2 in the merge queue');
    expect(card.textContent).toContain('Opened by octocat');
  });

  test('an issue closed as not planned shows no diff and no status row', () => {
    render(
      <GitHubReferenceCard
        preview={{
          kind: 'issue',
          repo: 'inkeep/agents',
          number: 7,
          title: 'Crash on start',
          author: null,
          createdAt: '2025-03-04T10:00:00Z',
          lifecycle: 'not-planned',
        }}
      />,
    );
    expect(screen.getByTestId('github-reference-state').textContent).toBe('Not planned');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTestId('github-reference-status')).toBeNull();
    expect(screen.getByTestId('github-reference-card').textContent).not.toContain('Opened by');
  });
});

describe('GitHub links in agent messages', () => {
  test('focusing a pull request link loads its card', async () => {
    const fetchMock = vi.fn(async () => respond({ ok: true, preview: OPEN_PULL }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<AgentMarkdown text="See https://github.com/inkeep/agents/pull/4979 for details." />);
    const link = screen.getByRole('link', { name: 'https://github.com/inkeep/agents/pull/4979' });
    expect(link.getAttribute('target')).toBe('_blank');
    fireEvent.focus(link);
    await waitFor(() => expect(screen.getByTestId('github-reference-card')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/github-reference', expect.anything());
  });

  test('leaving the link before the card loads never opens it later', async () => {
    let release: (res: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<AgentMarkdown text="https://github.com/inkeep/agents/pull/77" />);
    const link = screen.getByRole('link');
    fireEvent.focus(link);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.blur(link);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release(respond({ ok: true, preview: { ...OPEN_PULL, number: 77 } }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByTestId('github-reference-card')).toBeNull();
  });

  test('leaving one link does not cancel the card another link to the same pull request waits for', async () => {
    let release: (res: Response) => void = () => {};
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          release = resolve;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const url = 'https://github.com/inkeep/agents/pull/88';
    render(<AgentMarkdown text={`${url} and again ${url}`} />);
    const [first, second] = screen.getAllByRole('link');
    fireEvent.focus(first);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.focus(second);
    await waitFor(() => expect(second.getAttribute('data-state')).toBe('open'));
    fireEvent.blur(first);
    await waitFor(() => expect(first.getAttribute('data-state')).toBe('closed'));
    release(respond({ ok: true, preview: { ...OPEN_PULL, number: 88 } }));
    await waitFor(() =>
      expect(screen.getByTestId('github-reference-card').textContent).toContain('#88'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a link whose card is unavailable stays a plain link', async () => {
    const fetchMock = vi.fn(async () => respond({ ok: false, reason: 'not-found' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<AgentMarkdown text="https://github.com/inkeep/private/issues/12" />);
    fireEvent.focus(screen.getByRole('link'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId('github-reference-card')).toBeNull();
  });

  test('other links never ask for a card', async () => {
    const fetchMock = vi.fn(async () => respond({ ok: false, reason: 'unsupported' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<AgentMarkdown text="https://example.com/docs" />);
    fireEvent.focus(screen.getByRole('link'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
