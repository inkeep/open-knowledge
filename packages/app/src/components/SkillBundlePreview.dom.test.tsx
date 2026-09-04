import type { SkillPreview } from '@inkeep/open-knowledge-core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

type PreviewResult = ({ ok: true } & SkillPreview) | { ok: false; error: string };
let previewResult: PreviewResult = { ok: false, error: 'unset' };
vi.doMock('@/lib/skills-api', () => ({
  fetchSkillPreview: async () => previewResult,
}));

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
        name: 'demo',
        description: 'x'.repeat(36),
        skillMd: 'b'.repeat(800),
        files: [
          { relPath: 'references/a.md', content: 'y'.repeat(1200) },
          { relPath: 'scripts/run.sh', content: 'z'.repeat(4000) },
        ],
      }),
    );
    expect(cost.textContent).toContain('10');
    expect(cost.textContent).toContain('200');
    expect(cost.textContent).toContain('300');
    expect(cost.textContent).toContain('description');
    expect(cost.textContent).toContain('SKILL.md');
    expect(cost.textContent).toContain('other');
    expect(cost.textContent).not.toContain('1.3k');
  });

  test('renders zeroes, not a blank row, for a skill with no body and no references', async () => {
    const cost = await renderPreviewCost(
      ok({ name: 'e', description: null, skillMd: '', files: [] }),
    );
    expect(cost.textContent).toContain('0');
    expect(cost.textContent).toContain('SKILL.md');
    expect(cost.textContent).toContain('other');
  });

  test('skips a binary/null reference and counts the readable remainder', async () => {
    const cost = await renderPreviewCost(
      ok({
        files: [
          { relPath: 'references/bin.md', content: null },
          { relPath: 'references/ok.md', content: 'k'.repeat(400) },
        ],
      }),
    );
    expect(cost.textContent).toContain('100');
  });

  test('marks an over-budget tier and leaves on-demand bare', async () => {
    const cost = await renderPreviewCost(
      ok({
        name: 'sk',
        description: 'x'.repeat(438),
        skillMd: 'b'.repeat(40),
        files: [{ relPath: 'guide.md', content: 'y'.repeat(200_000) }],
      }),
    );
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
    expect(await screen.findByTestId('og-card')).toBeTruthy();
    expect(screen.queryByTestId('skill-cost-value')).toBeNull();
  });
});

describe('SkillBundlePreview read-only contract', () => {
  test('discloses cost but adds no install control of its own', async () => {
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

async function renderPreviewCost(
  result: PreviewResult,
  props: Partial<Parameters<typeof SkillBundlePreview>[0]> = {},
) {
  renderPreview(result, props);
  return screen.findByTestId('skill-cost-value');
}
