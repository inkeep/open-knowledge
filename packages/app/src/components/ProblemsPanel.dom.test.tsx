/**
 * Behavioral tests for ProblemsPanel: renders a row per diagnostic, shows the
 * empty state, and on row click dispatches a LINT_NAV_EVENT plus banks a
 * pending lint intent so the source editor can jump now or on its next
 * activation. Project scope runs the audit on demand (never on mount), caches
 * the result across scope flips, re-fetches only through the refresh
 * affordance, and click-navigates to the offending doc by hash.
 */

import type { LintDiagnostic, ValidationAuditResponse } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

// Both lingui macro specifiers alias to ONE shim module under the vitest dom
// config, so two mock registrations race for a single resolved module id and
// only one factory survives. The factories must be the same superset object —
// a specifier-shaped split (t on core, components on react) loses whichever
// half the race drops (observed: useLingui vanishing when the core factory
// won).
const linguiMacroMock = {
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
};
vi.doMock('@lingui/core/macro', () => linguiMacroMock);
vi.doMock('@lingui/react/macro', () => linguiMacroMock);

let auditCalls = 0;
let runLintAuditImpl: () => Promise<ValidationAuditResponse | null> = async () => null;
let fixLintDocCalls: string[] = [];
let fixLintDocImpl: (docName: string) => Promise<{ ok: boolean; errorDetail?: string | null }> =
  async () => ({ ok: true });
let projectLintConfigData: unknown = null;
const toastError = vi.fn((_message: string) => {});

const toastSuccess = vi.fn((_message: string) => {});
vi.doMock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.doMock('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {},
  subscribeToLintConfigChanged: () => () => {},
  fixLintDoc: (docName: string) => {
    fixLintDocCalls.push(docName);
    return fixLintDocImpl(docName);
  },
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: projectLintConfigData }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async () => ({ ok: false, errorDetail: null }),
}));
// The panel's project scope now consumes the unified audit plane.
vi.doMock('@/editor/validation-audit-client', () => ({
  runValidationAudit: () => {
    auditCalls += 1;
    return runLintAuditImpl();
  },
  useDocLinkFindings: () => [],
}));
// Page-list context for the dead-link "Create page" one-shot. `addPage` is the
// only member the panel touches.
const addPageCalls: string[] = [];
vi.doMock('@/components/PageListContext', () => ({
  useOptionalPageList: () => ({ addPage: (docName: string) => addPageCalls.push(docName) }),
}));
let createPageCalls: { initialDir: string; suggestedName: string }[] = [];
let createPageImpl: (seed: { initialDir: string; suggestedName: string }) => Promise<{
  docName: string;
}> = async (seed) => ({ docName: seed.suggestedName });
vi.doMock('@/lib/create-page', () => ({
  createPageFromSeedAndUpdate: async (
    seed: { initialDir: string; suggestedName: string },
    options: { addPage: (docName: string) => void },
  ) => {
    createPageCalls.push(seed);
    const created = await createPageImpl(seed);
    options.addPage(created.docName);
    return created;
  },
}));

/** Minimal lint-config payload with the plugin toggles the panel reads. */
function lintConfigWith(plugins: { markdownlint: boolean; frontmatter: boolean }): unknown {
  return {
    effective: {
      enabled: true,
      plugins: {
        markdownlint: { enabled: plugins.markdownlint, rules: {} },
        frontmatter: { enabled: plugins.frontmatter, schemas: [] },
      },
    },
    configFile: null,
    configProblems: [],
  };
}

const { ProblemsPanel, LINT_NAV_EVENT } = await import('./ProblemsPanel');
// The real registry, deliberately unmocked: the tests assert the banked intent
// through its public consume API — the same call the source editor replays.
const { consumePendingSourceNavigation, clearPendingSourceNavigationsForTest } = await import(
  '@/editor/source-editor-navigation'
);

/** Diagnostic at a 1-based line/column (the display convention these tests assert). */
function diag(over: Partial<LintDiagnostic> & { line?: number; column?: number }): LintDiagnostic {
  const { line = 3, column = 1, ...rest } = over;
  return {
    range: {
      start: { line: line - 1, character: column - 1 },
      end: { line: line - 1, character: column },
    },
    severity: 'warning',
    source: 'markdownlint',
    code: 'MD010',
    message: 'Hard tabs',
    ...rest,
  };
}

function auditResult(over: Partial<ValidationAuditResponse> = {}): ValidationAuditResponse {
  return { files: [], fileCount: 3, errorCount: 0, warningCount: 0, warnings: [], ...over };
}

/** A dead-link diagnostic as the links validator reports it on the wire. */
function linkDiag(
  over: Partial<LintDiagnostic> & { line?: number } = {},
): LintDiagnostic & { linkTarget: string } {
  return {
    ...diag({
      severity: 'warning',
      code: 'dead-link',
      message: 'Link target "ghost" does not resolve to an existing document.',
      ...over,
      // The wire's `source` is any validator id; the in-process type is narrower,
      // so route around it for the fixture.
      source: 'links' as LintDiagnostic['source'],
    }),
    linkTarget: 'ghost',
  };
}

beforeEach(() => {
  auditCalls = 0;
  runLintAuditImpl = async () => null;
  fixLintDocCalls = [];
  fixLintDocImpl = async () => ({ ok: true });
  projectLintConfigData = null;
  createPageCalls = [];
  createPageImpl = async (seed) => ({ docName: seed.suggestedName });
  addPageCalls.length = 0;
  toastError.mockClear();
  toastSuccess.mockClear();
});

afterEach(() => {
  cleanup();
  clearPendingSourceNavigationsForTest();
  window.location.hash = '';
});

describe('ProblemsPanel', () => {
  test('shows the empty state when there are no diagnostics', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    expect(screen.getByText('No problems found.')).toBeTruthy();
  });

  test('a compact Checked-by line reveals the active plugins in a tooltip', async () => {
    projectLintConfigData = lintConfigWith({ markdownlint: true, frontmatter: true });
    render(
      <TooltipProvider>
        <ProblemsPanel docName="notes" diagnostics={[]} />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId('problems-active-plugins');
    // The pill itself carries only the count — names live in the tooltip.
    expect(trigger.textContent).toContain('2 plugins');
    expect(trigger.textContent).not.toContain('markdownlint');
    fireEvent.focus(trigger);
    const tooltip = await screen.findByTestId('problems-active-plugins-tooltip');
    expect(tooltip.textContent).toContain('Checked by: markdownlint, Frontmatter schemas');
    // Plugins are on, so the ordinary empty state (not the no-plugins one) shows.
    expect(screen.getByText('No problems found.')).toBeTruthy();
    expect(screen.queryByTestId('problems-no-plugins')).toBeNull();
  });

  test('only enabled plugins appear in the tooltip', async () => {
    projectLintConfigData = lintConfigWith({ markdownlint: true, frontmatter: false });
    render(
      <TooltipProvider>
        <ProblemsPanel docName="notes" diagnostics={[]} />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId('problems-active-plugins');
    expect(trigger.textContent).toContain('1 plugin');
    fireEvent.focus(trigger);
    const tooltip = await screen.findByTestId('problems-active-plugins-tooltip');
    expect(tooltip.textContent).toContain('markdownlint');
    expect(tooltip.textContent).not.toContain('Frontmatter schemas');
  });

  test('with zero plugins enabled, the empty state names the gap and links to Settings', () => {
    projectLintConfigData = lintConfigWith({ markdownlint: false, frontmatter: false });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    expect(screen.queryByTestId('problems-active-plugins')).toBeNull();
    expect(screen.getByTestId('problems-no-plugins')).toBeTruthy();
    fireEvent.click(screen.getByTestId('problems-enable-plugins'));
    expect(window.location.hash).toBe('#settings/plugins-manage');
  });

  test('link findings still render with zero plugins enabled (links validate regardless)', () => {
    projectLintConfigData = lintConfigWith({ markdownlint: false, frontmatter: false });
    render(<ProblemsPanel docName="notes" diagnostics={[linkDiag()]} />);
    // The no-plugins hint only replaces the EMPTY list — a populated plane
    // (broken links) must never be hidden behind it.
    expect(screen.queryByTestId('problems-no-plugins')).toBeNull();
    expect(screen.getByText(/does not resolve/)).toBeTruthy();
  });

  test('while the lint config has not loaded, the panel makes no plugin claim', () => {
    projectLintConfigData = null;
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    expect(screen.queryByTestId('problems-active-plugins')).toBeNull();
    expect(screen.queryByTestId('problems-no-plugins')).toBeNull();
    expect(screen.getByText('No problems found.')).toBeTruthy();
  });

  test('a fixable row renders a Fix button that calls onFix; unfixable does not', () => {
    const fixable = diag({
      line: 3,
      code: 'MD010',
      fixes: [
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          newText: '  ',
        },
      ],
    });
    const unfixable = diag({ line: 5, code: 'MD025', message: 'Multiple H1' });
    const onFix = vi.fn(() => {});
    render(<ProblemsPanel docName="notes" diagnostics={[fixable, unfixable]} onFix={onFix} />);
    const fixButtons = screen.getAllByRole('button', { name: /Fix markdownlint\/MD010/ });
    expect(fixButtons).toHaveLength(1);
    // The unfixable row has no Fix button.
    expect(screen.queryByRole('button', { name: /Fix markdownlint\/MD025/ })).toBeNull();
    fixButtons[0]?.click();
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  test('without onFix, a fixable row renders no Fix button', () => {
    const fixable = diag({
      code: 'MD010',
      fixes: [
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          newText: '  ',
        },
      ],
    });
    render(<ProblemsPanel docName="notes" diagnostics={[fixable]} />);
    expect(screen.queryByRole('button', { name: /Fix markdownlint/ })).toBeNull();
  });

  test('doc-scope Fix all renders when onFixAll is provided and calls it on click', () => {
    const fixable = diag({
      code: 'MD010',
      fixes: [
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          newText: '  ',
        },
      ],
    });
    const unfixable = diag({ line: 5, code: 'MD025', message: 'Multiple H1' });
    const onFixAll = vi.fn(() => {});
    render(
      <ProblemsPanel docName="notes" diagnostics={[fixable, unfixable]} onFixAll={onFixAll} />,
    );
    const button = screen.getByTestId('problems-fix-all') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // The label sizes the click before it happens: only the fixable diagnostic
    // counts, not the total problem count.
    expect(button.textContent).toContain('(1)');
    button.click();
    expect(onFixAll).toHaveBeenCalledTimes(1);
  });

  test('Ask AI renders on fixable AND unfixable rows only when onAskAi is provided', () => {
    const fixable = diag({
      line: 3,
      code: 'MD010',
      fixes: [
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
          newText: '  ',
        },
      ],
    });
    const unfixable = diag({ line: 5, code: 'MD025', message: 'Multiple H1' });
    const onAskAi = vi.fn(() => {});
    const { unmount } = render(
      <ProblemsPanel docName="notes" diagnostics={[fixable, unfixable]} onAskAi={onAskAi} />,
    );
    const askButtons = screen.getAllByTestId('problems-ask-ai');
    // One per row — the unfixable row gets it too (AI matters most where no
    // deterministic fix exists).
    expect(askButtons).toHaveLength(2);
    askButtons[1]?.click();
    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect((onAskAi.mock.calls[0] as unknown[])[0]).toMatchObject({ code: 'MD025' });
    unmount();

    render(<ProblemsPanel docName="notes" diagnostics={[fixable, unfixable]} />);
    expect(screen.queryByTestId('problems-ask-ai')).toBeNull();
  });

  test('doc-scope Fix all is disabled when no diagnostic is fixable', () => {
    const onFixAll = vi.fn(() => {});
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[diag({ code: 'MD025', message: 'Multiple H1' })]}
        onFixAll={onFixAll}
      />,
    );
    const disabledButton = screen.getByTestId('problems-fix-all') as HTMLButtonElement;
    expect(disabledButton.disabled).toBe(true);
    expect(disabledButton.textContent).toContain('(0)');
  });

  test('doc-scope Fix all is absent without onFixAll or without diagnostics', () => {
    const { unmount } = render(<ProblemsPanel docName="notes" diagnostics={[diag({})]} />);
    expect(screen.queryByTestId('problems-fix-all')).toBeNull();
    unmount();
    // Empty state renders no action row at all.
    render(<ProblemsPanel docName="notes" diagnostics={[]} onFixAll={vi.fn(() => {})} />);
    expect(screen.queryByTestId('problems-fix-all')).toBeNull();
  });

  test('renders a row per diagnostic, sorted by line', () => {
    const diagnostics = [
      diag({ code: 'MD012', message: 'Multiple blanks', line: 9 }),
      diag({ code: 'MD010', message: 'Hard tabs', line: 2 }),
    ];
    render(<ProblemsPanel docName="notes" diagnostics={diagnostics} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    // Lower line sorts first.
    expect(buttons[0]?.textContent).toContain('MD010');
    expect(buttons[1]?.textContent).toContain('MD012');
  });

  test('clicking a row dispatches LINT_NAV_EVENT with the line', () => {
    let received: { line: number; column: number } | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<{ line: number; column: number }>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName="notes" diagnostics={[diag({ line: 7, column: 2 })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(received).toEqual({ line: 7, column: 2 });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('every row carries a source tag: lint for validators, link for dead links', () => {
    render(
      <ProblemsPanel docName="notes" diagnostics={[diag({ line: 2 }), linkDiag({ line: 5 })]} />,
    );
    const tags = screen.getAllByTestId('problems-source-tag');
    expect(tags).toHaveLength(2);
    expect(tags[0]?.textContent).toBe('lint');
    expect(tags[1]?.textContent).toBe('link');
  });

  test('a dead-link row offers the one-shot Create page action; lint rows do not', async () => {
    render(<ProblemsPanel docName="notes" diagnostics={[linkDiag({ line: 5 }), diag({})]} />);
    // Exactly one Create button — the lint row gets none.
    const createButtons = screen.getAllByTestId('problems-create-page');
    expect(createButtons).toHaveLength(1);

    fireEvent.click(createButtons[0] as HTMLElement);
    await waitFor(() =>
      expect(createPageCalls).toEqual([{ initialDir: '', suggestedName: 'ghost' }]),
    );
    // The created page lands in the page list (same flow as the Links panel).
    expect(addPageCalls).toEqual(['ghost']);
  });

  test('the create action is never counted by Fix all', () => {
    render(
      <ProblemsPanel docName="notes" diagnostics={[linkDiag({})]} onFixAll={vi.fn(() => {})} />,
    );
    // A dead link is not deterministically fixable — the Fix all label counts 0.
    const button = screen.getByTestId('problems-fix-all') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('(0)');
  });

  test('a dead-link row click-jumps to its line', () => {
    let received: { line: number; column: number } | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<{ line: number; column: number }>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName="notes" diagnostics={[linkDiag({ line: 5 })]} />);
      fireEvent.click(screen.getByRole('button', { name: /does not resolve/ }));
      expect(received).toEqual({ line: 5, column: 1 });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('clicking a row banks a pending lint intent for later source-mode activation', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[diag({ line: 7, column: 2 })]} />);
    fireEvent.click(screen.getByRole('button'));
    // Banked even though no source editor consumed the event (WYSIWYG case):
    // the next source-mode activation within the TTL replays it.
    expect(consumePendingSourceNavigation('notes')).toEqual({
      kind: 'lint',
      detail: { line: 7, column: 2 },
    });
  });
});

describe('ProblemsPanel — project scope', () => {
  test('audit runs on demand at first Project activation and renders per-file groups', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          {
            file: 'guides/setup.md',
            diagnostics: [
              diag({ line: 4 }),
              diag({ code: 'MD001', message: 'Heading increment', line: 8 }),
            ],
          },
          { file: 'notes.md', diagnostics: [diag({ line: 2 })] },
        ],
        fileCount: 5,
        warningCount: 3,
      });

    render(<ProblemsPanel docName="notes" diagnostics={[diag({ line: 1 })]} />);
    // Mounting the panel in doc scope never runs the audit.
    expect(auditCalls).toBe(0);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(auditCalls).toBe(1);

    // Per-file groups list their diagnostics (expanded by default) with counts.
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(screen.getByText('Heading increment')).toBeTruthy();
    const groups = screen.getAllByTestId('problems-audit-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelector('[data-testid="problems-audit-file-count"]')?.textContent).toBe(
      '2',
    );
    // The summary carries the audit-wide error/warning counts.
    expect(screen.getByTestId('problems-audit-summary').textContent).toContain('0 errors');
    expect(screen.getByTestId('problems-audit-summary').textContent).toContain('3 warnings');
  });

  test('project groups mix lint and link findings for one file, source-tagged', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          {
            file: 'guides/setup.md',
            diagnostics: [diag({ line: 4 }), linkDiag({ line: 9 })],
          },
        ],
        fileCount: 4,
        errorCount: 1,
        warningCount: 1,
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());

    const tags = screen.getAllByTestId('problems-source-tag');
    expect(tags.map((tag) => tag.textContent)).toEqual(['lint', 'link']);
    // The rollup summary carries the merged plane's counts.
    expect(screen.getByTestId('problems-audit-summary').textContent).toContain('1 error');
    expect(screen.getByTestId('problems-audit-summary').textContent).toContain('1 warning');
  });

  test('a project-scope dead-link row creates its target and re-audits the plane', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [{ file: 'guides/setup.md', diagnostics: [linkDiag({ line: 3 })] }],
        fileCount: 2,
        warningCount: 1,
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(auditCalls).toBe(1);

    fireEvent.click(screen.getByTestId('problems-create-page'));
    await waitFor(() =>
      expect(createPageCalls).toEqual([{ initialDir: '', suggestedName: 'ghost' }]),
    );
    // A loaded snapshot is stale truth after the create — the panel re-audits.
    await waitFor(() => expect(auditCalls).toBe(2));
  });

  test('the cached result is reused when toggling scopes; refresh re-fetches', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'first.md', diagnostics: [diag({})] }] });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('first.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('panel-scope-doc'));
    expect(screen.getByText('No problems found.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    // Re-activation shows the cached snapshot without a new fetch.
    expect(screen.getByText('first.md')).toBeTruthy();
    expect(auditCalls).toBe(1);

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'second.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByLabelText('Refresh audit'));
    await waitFor(() => expect(screen.getByText('second.md')).toBeTruthy());
    expect(auditCalls).toBe(2);
    expect(screen.queryByText('first.md')).toBeNull();
  });

  test('a pending audit shows the loading skeleton with the refresh disabled', async () => {
    let resolveAudit: (value: ValidationAuditResponse | null) => void = () => {};
    runLintAuditImpl = () =>
      new Promise((resolve) => {
        resolveAudit = resolve;
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByLabelText('Refresh audit') as HTMLButtonElement).disabled).toBe(true);

    resolveAudit(auditResult({ fileCount: 2 }));
    await waitFor(() => expect(screen.getByText('No problems across 2 documents.')).toBeTruthy());
    expect((screen.getByLabelText('Refresh audit') as HTMLButtonElement).disabled).toBe(false);
  });

  test('a failed audit surfaces the error and refresh retries it', async () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() =>
      expect(screen.getByText('The audit could not be completed. Try again.')).toBeTruthy(),
    );

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'retried.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByLabelText('Refresh audit'));
    await waitFor(() => expect(screen.getByText('retried.md')).toBeTruthy());
    expect(screen.queryByText('The audit could not be completed. Try again.')).toBeNull();
  });

  test('config warnings from the audit render above the file groups', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [{ file: 'notes.md', diagnostics: [diag({})] }],
        warnings: ['Failed to parse .markdownlint.json: unexpected token'],
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() =>
      expect(screen.getByText('Failed to parse .markdownlint.json: unexpected token')).toBeTruthy(),
    );
  });

  test('clicking a project-scope diagnostic for another doc navigates by hash and banks the intent', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [{ file: 'guides/setup.md', diagnostics: [diag({ line: 4, column: 2 })] }],
      });
    let navEvents = 0;
    const listener = () => {
      navEvents += 1;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName="notes" diagnostics={[]} />);
      fireEvent.click(screen.getByTestId('panel-scope-project'));
      await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: /Hard tabs/ }));

      expect(window.location.hash).toBe('#/guides/setup');
      expect(consumePendingSourceNavigation('guides/setup')).toEqual({
        kind: 'lint',
        detail: { line: 4, column: 2 },
      });
      // The in-doc nav event stays quiet on cross-doc clicks — it carries no
      // docName and would move the cursor in the doc that is still open.
      expect(navEvents).toBe(0);
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('clicking a project-scope diagnostic for the open doc keeps the in-doc event fast path', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'notes.md', diagnostics: [diag({ line: 7, column: 2 })] }] });
    let received: { line: number; column: number } | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<{ line: number; column: number }>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName="notes" diagnostics={[]} />);
      fireEvent.click(screen.getByTestId('panel-scope-project'));
      await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy());
      const hashBefore = window.location.hash;

      fireEvent.click(screen.getByRole('button', { name: /Hard tabs/ }));

      expect(received).toEqual({ line: 7, column: 2 });
      expect(window.location.hash).toBe(hashBefore);
      expect(consumePendingSourceNavigation('notes')).toEqual({
        kind: 'lint',
        detail: { line: 7, column: 2 },
      });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('project Fix all sweeps only fixable files, re-audits, and stays quiet on success', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          { file: 'a.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
          { file: 'b.md', diagnostics: [diag({ code: 'MD025', message: 'Multiple H1' })] },
          { file: 'nested/c.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
        ],
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());

    // Counts fixable problems across the audit (a.md + nested/c.md), not files
    // and not the unfixable b.md diagnostic.
    expect(screen.getByTestId('problems-fix-all').textContent).toContain('(2)');
    fireEvent.click(screen.getByTestId('problems-fix-all'));
    // Only the two files carrying fixable diagnostics are swept, extension-less.
    await waitFor(() => expect(fixLintDocCalls).toEqual(['a', 'nested/c']));
    // The sweep ends in a fresh audit fetch (initial activation + re-audit).
    await waitFor(() => expect(auditCalls).toBe(2));
    expect(toastError).not.toHaveBeenCalled();
  });

  test('project Fix all continues past per-file failures and surfaces one error toast', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          { file: 'bad.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
          { file: 'good.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
        ],
      });
    fixLintDocImpl = async (docName) =>
      docName === 'bad' ? { ok: false, errorDetail: 'conflict' } : { ok: true };
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('bad.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-fix-all'));
    // The failed file does not stop the sweep.
    await waitFor(() => expect(fixLintDocCalls).toEqual(['bad', 'good']));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(String(toastError.mock.calls[0]?.[0])).toContain('1 of 2');
    // The toast names the first casualty and the server's reason.
    const options = toastError.mock.calls[0]?.[1] as { description?: string } | undefined;
    expect(options?.description).toBe('bad.md — conflict');
  });

  test('failure toast omits the dash-suffix when the server gives no error detail', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'bad.md', diagnostics: [diag({ fixes: [fixableEdit] })] }] });
    fixLintDocImpl = async () => ({ ok: false, errorDetail: null });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('bad.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-fix-all'));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    // Null detail → just the filename, no ` — ` suffix.
    const options = toastError.mock.calls[0]?.[1] as { description?: string } | undefined;
    expect(options?.description).toBe('bad.md');
  });

  test('project Fix all is disabled while loading and when nothing is fixable', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [{ file: 'plain.md', diagnostics: [diag({ code: 'MD025' })] }],
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('plain.md')).toBeTruthy());
    // Loaded audit with zero fixable files keeps the button disabled.
    expect((screen.getByTestId('problems-fix-all') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('problems-fix-all'));
    expect(fixLintDocCalls).toEqual([]);
  });

  test('doc-scope content and count stay doc-scoped while project scope is active', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'other.md', diagnostics: [diag({}), diag({ line: 9 })] }] });
    render(<ProblemsPanel docName="notes" diagnostics={[diag({ line: 1 })]} />);
    // Doc scope shows the doc's own diagnostic count in the panel header.
    expect(screen.getByText('1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('other.md')).toBeTruthy());
    // The header count belongs to doc scope; project scope drops it rather
    // than mislabel project totals with the doc's number.
    expect(screen.queryByText('1', { selector: '[data-slot="panel-count"]' })).toBeNull();

    fireEvent.click(screen.getByTestId('panel-scope-doc'));
    expect(screen.getByText('Hard tabs')).toBeTruthy();
  });
});
