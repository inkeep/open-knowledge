/**
 * `SkillFileViewer` reads a skill bundle file through the SCOPE-AWARE
 * `/api/skill-file` endpoint (via `loadSkillFileText` → `getSkillFile`), not the
 * content-dir asset server. This is the regression guard for the bug where
 * clicking a GLOBAL skill's `references/*.md` or `scripts/*.sh` showed
 * "Couldn't load … This file could not be found." — the file lives under
 * `~/.ok/skills/`, outside the project content dir the asset server
 * (`/api/asset-text`) knows about, so the asset path 404'd.
 *
 * It also pins the render dispatch by extension:
 *
 *   1. A `.md` reference renders as FORMATTED, read-only markdown (the rendered
 *      view, not the CodeMirror source view) — a `# Heading` becomes an `<h1>`,
 *      not literal `#` text.
 *   2. A `.sh` script renders through the source `TextViewer`.
 *   3. A failing read lands in an error pane (terminal state), never a
 *      perpetual loading spinner.
 *
 * Runs under `bun run test:dom` (jsdom substrate).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';

// Mock the shared loader both render branches call. Capturing its args is the
// load-bearing proof the read routes through the scope-aware endpoint (not the
// content-dir asset path).
const loadSkillFileTextMock = mock(
  async (_input: { scope: string; name: string; path: string }) =>
    ({ ok: true, text: '' }) as { ok: true; text: string } | { ok: false; status?: number },
);
mock.module('@/lib/skills-api', () => ({
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
    // The rendered-markdown view (not the source TextViewer) mounts.
    await waitFor(() => {
      expect(container.querySelector('[data-skill-markdown-viewer]')).not.toBeNull();
    });
    // Read through the scope-aware loader with the exact coordinates, plus the
    // viewer's AbortSignal (forwarded so rapid navigation aborts the in-flight read).
    expect(loadSkillFileTextMock).toHaveBeenCalledWith(
      {
        scope: 'global',
        name: 'trip-log',
        path: 'references/guide.md',
      },
      expect.any(AbortSignal),
    );
    // Rendered, not raw: the markdown produced real prose nodes, and the literal
    // markdown syntax (`#`, `**`) is NOT shown verbatim.
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe('Reference body');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.textContent ?? '').not.toContain('# Reference body');
    expect(container.textContent ?? '').not.toContain('**bold**');
    // The read-only render must NOT be editable / collab-bound.
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    // The source viewer must NOT be used for the markdown case.
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
    // Not the rendered-markdown surface.
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
    // No content-dir "Open file" handoff for a skill file (no asset URL).
    expect(container.querySelector('a[href*="/api/asset"]')).toBeNull();
  });
});
