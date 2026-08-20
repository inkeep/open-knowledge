/**
 * The Problems-row navigation detail produced by the panel itself, fed a REAL
 * OKF frontmatter diagnostic from the real lint engine. The sibling suite only
 * ever clicks hand-built diagnostics and asserts the detail's existing fields,
 * so it cannot notice when the panel drops a field the WYSIWYG consumer needs.
 *
 * The contract under test: a row click must dispatch a `LINT_NAV_EVENT` whose
 * detail carries the diagnostic's `frontmatterScope` alongside the existing
 * docName/line/column/source fields. The WYSIWYG editor declines navigation by
 * that scope metadata (a frontmatter violation has no body anchor); a detail
 * that omits it makes the consumer fall back to plugin identity, which admits
 * OKF's frontmatter findings into body navigation.
 */

import { type LinterConfig, lintDocument } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DiagnosticLike, LintNavDetail } from './ProblemsPanel';

// Mocked at the HTTP boundary exactly as the sibling suite does: the panel
// fetches the effective lint config and (in project scope) the audit plane on
// mount/activation, and this test exercises neither surface.
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

// A concept-scoped doc name (anything but a reserved `index`/`log` filename),
// matching the OKF recommended schemas' appliesTo scoping.
const DOC_NAME = 'usability-sessions/kenny/notes/serafin';

// OKF alone: the engine's frontmatter-required rule is the only producer here,
// so the panel renders exactly one row and the click target is unambiguous.
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

/** Production mounts the panel under main.tsx's root TooltipProvider. */
function render(ui: ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('ProblemsPanel navigation detail for a real OKF frontmatter diagnostic', () => {
  test('a row click dispatches a detail carrying the diagnostic frontmatterScope', async () => {
    // Frontmatter present but missing the required `type` property.
    const text = '---\ntitle: Serafin\ndescription: Session notes\ntags: []\n---\n\nSome notes.\n';
    const diagnostics: DiagnosticLike[] = await lintDocument(text, config, DOC_NAME);

    // Producer half of the contract (already upheld): the real engine emits the
    // violation scope-tagged. If these fail, the fixture broke — not the panel.
    const produced = diagnostics.find(
      (d) => d.source === 'okf' && d.code === 'frontmatter-required',
    );
    expect(produced?.frontmatterScope).toBe('missing');
    expect(produced?.frontmatterProperty).toBe('type');

    // Consumer half: the panel's own detail must carry that scope forward.
    // `frontmatterScope` is asserted through the diagnostic's wire shape so the
    // expectation stays valid whether or not `LintNavDetail` declares it yet.
    let received: (LintNavDetail & Pick<DiagnosticLike, 'frontmatterScope'>) | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<LintNavDetail>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName={DOC_NAME} diagnostics={diagnostics} />);
      fireEvent.click(screen.getByRole('button'));
      expect(received).not.toBeNull();
      // toMatchObject, not toEqual: the detail may legitimately carry further
      // diagnostic metadata (e.g. the property name) beyond this contract.
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
