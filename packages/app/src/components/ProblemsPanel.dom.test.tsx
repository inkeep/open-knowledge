/**
 * Behavioral tests for ProblemsPanel: renders a row per diagnostic, shows the
 * empty state, and on row click dispatches a LINT_NAV_EVENT plus banks a
 * pending lint intent so the source editor can jump now or on its next
 * activation. Project scope runs the audit on demand (never on mount), caches
 * the result across scope flips, re-fetches only through the refresh
 * affordance, and click-navigates to the offending doc by hash.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { LintAuditResponse, LintDiagnostic } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

// Both lingui macro specifiers alias to ONE shim module under the vitest dom
// config, so two mock registrations race for a single resolved module id and
// only one factory survives. The factories must be the same superset object —
// a specifier-shaped split (t on core, components on react) loses whichever
// half the race drops (observed: useLingui vanishing when the core factory
// won).
const linguiMacroMock = {
  t: renderLinguiTemplate,
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
};
mock.module('@lingui/core/macro', () => linguiMacroMock);
mock.module('@lingui/react/macro', () => linguiMacroMock);

let auditCalls = 0;
let runLintAuditImpl: () => Promise<LintAuditResponse | null> = async () => null;
let fixLintDocCalls: string[] = [];
let fixLintDocImpl: (docName: string) => Promise<{ ok: boolean; errorDetail?: string | null }> =
  async () => ({ ok: true });
const toastError = mock((_message: string) => {});

mock.module('sonner', () => ({ toast: { error: toastError } }));
mock.module('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {},
  subscribeToLintConfigChanged: () => () => {},
  runLintAudit: () => {
    auditCalls += 1;
    return runLintAuditImpl();
  },
  fixLintDoc: (docName: string) => {
    fixLintDocCalls.push(docName);
    return fixLintDocImpl(docName);
  },
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: null }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async () => ({ ok: false, errorDetail: null }),
}));

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

function auditResult(over: Partial<LintAuditResponse> = {}): LintAuditResponse {
  return { files: [], fileCount: 3, errorCount: 0, warningCount: 0, warnings: [], ...over };
}

beforeEach(() => {
  auditCalls = 0;
  runLintAuditImpl = async () => null;
  fixLintDocCalls = [];
  fixLintDocImpl = async () => ({ ok: true });
  toastError.mockClear();
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
    const onFix = mock(() => {});
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
    const onFixAll = mock(() => {});
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
    const onAskAi = mock(() => {});
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
    const onFixAll = mock(() => {});
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
    render(<ProblemsPanel docName="notes" diagnostics={[]} onFixAll={mock(() => {})} />);
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
    let resolveAudit: (value: LintAuditResponse | null) => void = () => {};
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
