/**
 * RTL tests for the pre-install skill preview: a `tokens` property row priced
 * client-side from the fetched payload, and the read-only contract — the preview
 * discloses cost but carries no install control of its own.
 *
 * No test file existed for `SkillBundlePreview` before (the `SkillPreviewTab`
 * tests mock it away), so the fetch boundary and the editor's markdown viewer
 * are the only stubs; the row, its estimator wiring and the degrade-on-failure
 * path all run for real.
 */
import type { SkillPreview } from '@inkeep/open-knowledge-core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

// The one system boundary: the `/api/skills/preview` fetch. Each render sets the
// result it should resolve; a per-render source keeps the module-level preview
// cache from serving one test's payload to the next.
type PreviewResult = ({ ok: true } & SkillPreview) | { ok: false; error: string };
let previewResult: PreviewResult = { ok: false, error: 'unset' };
vi.doMock('@/lib/skills-api', () => ({
  fetchSkillPreview: async () => previewResult,
}));

// The rendered-markdown viewer binds a static TipTap editor; the tokens row
// sits above it and needs none of that, so stub it to keep the test on the row.
vi.doMock('@/components/SkillMarkdownViewer', () => ({
  SkillMarkdownViewer: () => <div data-testid="skill-md-viewer" />,
}));

const { SkillBundlePreview } = await import('./SkillBundlePreview');

let sourceCounter = 0;
function renderPreview(
  result: PreviewResult,
  props: Partial<Parameters<typeof SkillBundlePreview>[0]> = {},
) {
  previewResult = result;
  return render(
    <SkillBundlePreview
      source={`test-source-${sourceCounter++}`}
      name="sk"
      subtitle="acme/sk"
      tintKey="sk"
      headerActions={null}
      headerLine="preview"
      {...props}
    />,
  );
}

function ok(overrides: Partial<SkillPreview>): { ok: true } & SkillPreview {
  return {
    ok: true,
    name: 'sk',
    description: null,
    skillMd: '',
    files: [],
    ...overrides,
  };
}

describe('SkillBundlePreview tokens row', () => {
  test('prices the three tiers from the fetched payload, excluding non-readable files', async () => {
    const cost = await renderPreviewCost(
      ok({
        name: 'demo', // 4 chars
        description: 'x'.repeat(36), // 36 → always-on (4+36)/4 = 10
        skillMd: 'b'.repeat(800), // no frontmatter → whole body → on-trigger 200
        files: [
          { relPath: 'references/a.md', content: 'y'.repeat(1200) }, // 1200 → 300
          { relPath: 'scripts/run.sh', content: 'z'.repeat(4000) }, // excluded by extension
        ],
      }),
    );
    expect(cost.textContent).toContain('10');
    expect(cost.textContent).toContain('200');
    expect(cost.textContent).toContain('300');
    expect(cost.textContent).toContain('description');
    expect(cost.textContent).toContain('SKILL.md');
    expect(cost.textContent).toContain('other');
    // Had the script counted, the other tier would read 1.3k — it must not.
    expect(cost.textContent).not.toContain('1.3k');
  });

  test('renders zeroes, not a blank row, for a skill with no body and no references', async () => {
    const cost = await renderPreviewCost(
      ok({ name: 'e', description: null, skillMd: '', files: [] }),
    );
    // Explicit zeroes — never an absent row that could read as a free skill.
    expect(cost.textContent).toContain('0');
    expect(cost.textContent).toContain('SKILL.md');
    expect(cost.textContent).toContain('other');
  });

  test('skips a binary/null reference and counts the readable remainder', async () => {
    const cost = await renderPreviewCost(
      ok({
        files: [
          { relPath: 'references/bin.md', content: null }, // binary → skipped
          { relPath: 'references/ok.md', content: 'k'.repeat(400) }, // 400 → 100
        ],
      }),
    );
    expect(cost.textContent).toContain('100');
  });

  test('marks an over-budget tier and leaves on-demand bare', async () => {
    const cost = await renderPreviewCost(
      ok({
        name: 'sk',
        description: 'x'.repeat(438), // (2+438)/4 = 110 → over the ~100 always-on budget
        skillMd: 'b'.repeat(40), // on-trigger 10, under budget
        files: [{ relPath: 'guide.md', content: 'y'.repeat(200_000) }], // on-demand ~50k, no norm
      }),
    );
    // Only always-on is marked; on-demand has no published norm, so its large
    // figure stays unmarked.
    const marks = screen.getAllByRole('img');
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute('aria-label')).toMatch(/over the .* token budget/);
    expect(cost.textContent).toContain('50k');
  });
});

describe('SkillBundlePreview degradation', () => {
  test('omits the tokens row and shows the fallback when the fetch fails', async () => {
    renderPreview(
      { ok: false, error: 'clone failed' },
      { noPreviewFallback: <div data-testid="og-card">no preview</div> },
    );
    // The failed fetch degrades to the caller's fallback; no cost is invented.
    expect(await screen.findByTestId('og-card')).toBeTruthy();
    expect(screen.queryByTestId('skill-cost-value')).toBeNull();
  });
});

describe('SkillBundlePreview read-only contract', () => {
  test('discloses cost but adds no install control of its own', async () => {
    // A built-in supplies only a source link + Update as header actions; the
    // preview must show the cost yet offer no way to write.
    const headerActions: ReactNode = (
      <a href="https://example.test/source" data-testid="source-link">
        Source
      </a>
    );
    const cost = await renderPreviewCost(
      ok({ description: 'a read-only built-in', skillMd: '# Body' }),
      { headerActions },
    );
    expect(cost).toBeTruthy();
    expect(screen.getByTestId('source-link')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /uninstall/i })).toBeNull();
  });
});

/** Render, wait for the async preview to resolve, return the cost row element. */
async function renderPreviewCost(
  result: PreviewResult,
  props: Partial<Parameters<typeof SkillBundlePreview>[0]> = {},
) {
  renderPreview(result, props);
  return screen.findByTestId('skill-cost-value');
}
