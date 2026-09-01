import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const loadSkillFileTextMock = vi.fn(
  async (_input: { scope: string; name: string; path: string }) =>
    ({ ok: true, text: '' }) as { ok: true; text: string } | { ok: false; status?: number },
);
vi.doMock('@/lib/skills-api', () => ({
  loadSkillFileText: loadSkillFileTextMock,
}));

const { SkillFileViewer } = await import('./SkillFileViewer.tsx');

describe('SkillFileViewer — scope-aware bundle-file read + render dispatch', () => {
  afterEach(() => {
    cleanup();
    loadSkillFileTextMock.mockReset();
  });

  test('global reference (.md) renders as formatted markdown (not source)', async () => {
    loadSkillFileTextMock.mockResolvedValueOnce({
      ok: true,
      text: '# Reference body\n\nSome **bold** prose.\n',
    });
    const { container } = render(
      <SkillFileViewer scope="global" name="trip-log" path="references/guide.md" />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-skill-markdown-viewer]')).not.toBeNull();
    });
    expect(loadSkillFileTextMock).toHaveBeenCalledWith(
      {
        scope: 'global',
        name: 'trip-log',
        path: 'references/guide.md',
      },
      expect.any(AbortSignal),
    );
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe('Reference body');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.textContent ?? '').not.toContain('# Reference body');
    expect(container.textContent ?? '').not.toContain('**bold**');
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(container.querySelector('[data-text-viewer]')).toBeNull();
  });

  test('global script (.sh) renders through the source TextViewer', async () => {
    loadSkillFileTextMock.mockResolvedValueOnce({ ok: true, text: 'echo hi' });
    const { container } = render(
      <SkillFileViewer scope="global" name="trip-log" path="scripts/run.sh" />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-text-viewer-state="loaded"]')).not.toBeNull();
    });
    expect(loadSkillFileTextMock).toHaveBeenCalledWith(
      {
        scope: 'global',
        name: 'trip-log',
        path: 'scripts/run.sh',
      },
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-text-viewer-extension="sh"]')).not.toBeNull();
    expect(container.querySelector('[data-skill-markdown-viewer]')).toBeNull();
  });

  test('a failed markdown read lands in the error pane (terminal, not perpetual loading)', async () => {
    loadSkillFileTextMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const { container } = render(
      <SkillFileViewer scope="global" name="trip-log" path="references/missing.md" />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-skill-markdown-state="error"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-skill-markdown-state="loading"]')).toBeNull();
    expect(container.querySelector('a[href*="/api/asset"]')).toBeNull();
  });

  test('a references/ bundle-path chip is decorated as a clickable skill-path link (PRD-7607 part 2)', async () => {
    loadSkillFileTextMock.mockResolvedValueOnce({
      ok: true,
      text: 'See `references/pressure-testing.md` for the drill.\n',
    });
    const { container } = render(
      <SkillFileViewer scope="global" name="trip-log" path="references/guide.md" />,
    );
    await waitFor(() => {
      expect(container.querySelector('.ok-skill-path-link[data-skill-path]')).not.toBeNull();
    });
    expect(container.querySelector('[data-skill-path]')?.getAttribute('data-skill-path')).toBe(
      'references/pressure-testing.md',
    );
  });

  test('shows the read-only eye banner so the read-only state is visible (§8.11)', () => {
    loadSkillFileTextMock.mockResolvedValueOnce({ ok: true, text: 'echo hi\n' });
    const { container } = render(
      <SkillFileViewer scope="global" name="trip-log" path="scripts/run.sh" />,
    );
    expect(container.textContent).toContain('Read-only file in the trip-log skill');
  });
});
