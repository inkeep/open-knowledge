import { type LinterConfig, lintDocument } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DiagnosticLike, LintNavDetail } from './ProblemsPanel';

vi.doMock('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {},
  subscribeToLintConfigChanged: () => () => {},
  fixLintDoc: async () => ({ ok: true }),
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: null }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async () => ({ ok: false, errorDetail: null }),
}));
vi.doMock('@/editor/validation-audit-client', () => ({
  AUDIT_SUPERSEDED: 'audit-superseded',
  runValidationAudit: async () => null,
  useDocLinkFindings: () => ({ status: 'loaded', findings: [] }),
}));

const { ProblemsPanel, LINT_NAV_EVENT } = await import('./ProblemsPanel');
const { clearPendingSourceNavigationsForTest } = await import('@/editor/source-editor-navigation');

const DOC_NAME = 'usability-sessions/kenny/notes/serafin';

const config: LinterConfig = {
  enabled: true,
  plugins: {
    markdownlint: { enabled: false, rules: {} },
    frontmatter: { enabled: false, schemas: [] },
    okf: { enabled: true },
  },
};

afterEach(() => {
  cleanup();
  clearPendingSourceNavigationsForTest();
});

function render(ui: ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('ProblemsPanel navigation detail for a real OKF frontmatter diagnostic', () => {
  test('a row click dispatches a detail carrying the diagnostic frontmatterScope', async () => {
    const text = '---\ntitle: Serafin\ndescription: Session notes\ntags: []\n---\n\nSome notes.\n';
    const diagnostics: DiagnosticLike[] = await lintDocument(text, config, DOC_NAME);

    const produced = diagnostics.find(
      (d) => d.source === 'okf' && d.code === 'frontmatter-required',
    );
    expect(produced?.frontmatterScope).toBe('missing');
    expect(produced?.frontmatterProperty).toBe('type');

    let received: (LintNavDetail & Pick<DiagnosticLike, 'frontmatterScope'>) | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<LintNavDetail>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName={DOC_NAME} diagnostics={diagnostics} />);
      fireEvent.click(screen.getByRole('button'));
      expect(received).not.toBeNull();
      expect(received).toMatchObject({
        docName: DOC_NAME,
        line: (produced?.range.start.line ?? Number.NaN) + 1,
        column: (produced?.range.start.character ?? Number.NaN) + 1,
        source: 'okf',
        frontmatterScope: 'missing',
      });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });
});
