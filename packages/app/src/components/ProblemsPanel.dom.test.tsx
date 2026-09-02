import type { LintDiagnostic, ValidationAuditResponse } from '@inkeep/open-knowledge-core';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SWEEP_PROGRESS_CHUNK, sweepProgressInterval } from '@/components/problems-sweep';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { LintNavDetail } from './ProblemsPanel';

const linguiMacroMock = {
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
  plural: (value: number, { one, other }: { one: string; other: string }) =>
    (value === 1 ? one : other).replace('#', String(value)),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
};
vi.doMock('@lingui/core/macro', () => linguiMacroMock);
vi.doMock('@lingui/react/macro', () => linguiMacroMock);

let auditCalls = 0;
const AUDIT_SUPERSEDED = 'audit-superseded' as const;
let runLintAuditImpl: () => Promise<ValidationAuditResponse | null | typeof AUDIT_SUPERSEDED> =
  async () => null;
let fixLintDocCalls: string[] = [];
let fixLintDocImpl: (docName: string) => Promise<{
  ok: boolean;
  errorDetail?: string | null;
  status?: number | null;
  problemType?: string | null;
}> = async () => ({ ok: true });
let projectLintConfigData: unknown = null;
const toastError = vi.fn((_message: string) => {});

const toastSuccess = vi.fn((_message: string) => {});
const toastInfo = vi.fn((_message: string) => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess, info: toastInfo },
}));
const lintConfigListeners = new Set<() => void>();
function emitLintConfigChangedForTest(): void {
  for (const listener of lintConfigListeners) listener();
}
vi.doMock('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {},
  subscribeToLintConfigChanged: (onChange: () => void) => {
    lintConfigListeners.add(onChange);
    return () => lintConfigListeners.delete(onChange);
  },
  fixLintDoc: (docName: string) => {
    fixLintDocCalls.push(docName);
    return fixLintDocImpl(docName);
  },
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: projectLintConfigData }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async () => ({ ok: false, errorDetail: null }),
}));
vi.doMock('@/editor/validation-audit-client', () => ({
  AUDIT_SUPERSEDED,
  runValidationAudit: () => {
    auditCalls += 1;
    return runLintAuditImpl();
  },
  useDocLinkFindings: () => ({ status: 'loaded', findings: [] }),
}));
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

function lintConfigWith(plugins: { markdownlint: boolean; frontmatter: boolean }): unknown {
  return {
    effective: {
      enabled: true,
      plugins: {
        markdownlint: { enabled: plugins.markdownlint, rules: {} },
        frontmatter: { enabled: plugins.frontmatter, schemas: [] },
        okf: { enabled: false },
      },
    },
    configFile: null,
    configProblems: [],
  };
}

const { ProblemsPanel, LINT_NAV_EVENT } = await import('./ProblemsPanel');
const { __resetProjectFixSweepForTests } = await import('@/lib/project-fix-sweep-store');
const { consumePendingSourceNavigation, clearPendingSourceNavigationsForTest } = await import(
  '@/editor/source-editor-navigation'
);
const { consumePendingDocPanelRequest, requestDocPanelTab } = await import('./doc-panel-events');

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

function linkDiag(
  over: Partial<LintDiagnostic> & { line?: number } = {},
): LintDiagnostic & { linkTarget: string } {
  return {
    ...diag({
      severity: 'warning',
      code: 'dead-link',
      message: 'Link target "ghost" does not resolve to an existing document.',
      ...over,
      source: 'links' as LintDiagnostic['source'],
    }),
    linkTarget: 'ghost',
  };
}

type LocalTargetEvidence = {
  href: string;
  targetKind: 'document' | 'file' | 'unknown';
  role: 'link' | 'image';
  sourceForm: 'markdown-inline' | 'markdown-reference' | 'html-img';
  resolvedTarget: string | null;
  reason: string;
  resolutionMethod: string;
  definition?: { line: number; label: string };
};

function localTargetDiag(args: {
  line?: number;
  message: string;
  role: 'link' | 'image';
  targetKind: 'document' | 'file' | 'unknown';
  sourceForm?: LocalTargetEvidence['sourceForm'];
  resolvedTarget?: string | null;
  reason?: string;
  linkTarget?: string;
  definition?: { line: number; label: string };
}): LintDiagnostic & { localTarget: LocalTargetEvidence; linkTarget?: string } {
  return {
    ...diag({
      line: args.line ?? 3,
      severity: 'warning',
      code: 'dead-link',
      message: args.message,
      source: 'links' as LintDiagnostic['source'],
    }),
    ...(args.linkTarget !== undefined ? { linkTarget: args.linkTarget } : {}),
    localTarget: {
      href: args.resolvedTarget ?? 'assets/x',
      targetKind: args.targetKind,
      role: args.role,
      sourceForm: args.sourceForm ?? 'markdown-inline',
      resolvedTarget: args.resolvedTarget ?? null,
      reason: args.reason ?? 'no-such-file',
      resolutionMethod: 'source-relative',
      ...(args.definition ? { definition: args.definition } : {}),
    },
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
  toastInfo.mockClear();
  lintConfigListeners.clear();
  __resetProjectFixSweepForTests();
});

afterEach(() => {
  cleanup();
  clearPendingSourceNavigationsForTest();
  __resetProjectFixSweepForTests();
  window.location.hash = '';
  consumePendingDocPanelRequest('problems');
});

function render(ui: ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

function expandGroup(filePath: string) {
  const header = screen.getByText(filePath);
  fireEvent.click(header.closest('button') ?? header);
}

function sweepLiveRegion(): HTMLElement | undefined {
  return screen
    .queryAllByRole('status')
    .find((el) => /Fixing \d+ of \d+ files/.test(el.textContent ?? ''));
}

describe('ProblemsPanel', () => {
  test('shows the empty state when there are no diagnostics', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    expect(screen.getByText('No problems found.')).toBeTruthy();
  });

  test('qualifies the empty state when Markdown checks do not apply', () => {
    render(<ProblemsPanel docName="glossary.csv" diagnostics={[]} />);
    expect(screen.getByTestId('problems-markdown-not-applicable').textContent).toBe(
      'Markdown checks do not apply to this file.',
    );
    expect(screen.queryByText('No problems found.')).toBeNull();
  });

  test('hides the plugin pill for editable text in doc scope but keeps it in project scope', () => {
    projectLintConfigData = lintConfigWith({ markdownlint: true, frontmatter: true });
    render(<ProblemsPanel docName="glossary.csv" diagnostics={[]} />);
    expect(screen.queryByTestId('problems-active-plugins')).toBeNull();

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    expect(screen.getByTestId('problems-active-plugins')).toBeTruthy();
  });

  test('does not claim the document is clean while link validation is loading', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} linkFindingsStatus="loading" />);
    expect(screen.getByRole('status').textContent).toContain('Checking links');
    expect(screen.queryByText('No problems found.')).toBeNull();
  });

  test('reports an unavailable link plane instead of a clean document', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} linkFindingsStatus="failed" />);
    expect(screen.getByTestId('problems-links-failed').textContent).toBe(
      'Link validation is unavailable.',
    );
    expect(screen.queryByText('No problems found.')).toBeNull();
  });

  test('labels retained problems as last known when a refresh fails', () => {
    render(
      <ProblemsPanel docName="notes" diagnostics={[linkDiag()]} linkFindingsStatus="failed" />,
    );
    expect(screen.getByTestId('problems-links-failed').textContent).toContain(
      'Showing last known problems',
    );
    expect(screen.getByText(/does not resolve/)).toBeTruthy();
  });

  test('a compact Checked-by line reveals the active plugins in a tooltip', async () => {
    projectLintConfigData = lintConfigWith({ markdownlint: true, frontmatter: true });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    const trigger = screen.getByTestId('problems-active-plugins');
    expect(trigger.textContent).toContain('2 plugins');
    expect(trigger.textContent).not.toContain('markdownlint');
    fireEvent.focus(trigger);
    const tooltip = await screen.findByTestId('problems-active-plugins-tooltip');
    expect(tooltip.textContent).toContain('Checked by: markdownlint, Frontmatter schemas');
    expect(screen.getByText('No problems found.')).toBeTruthy();
    expect(screen.queryByTestId('problems-no-plugins')).toBeNull();
  });

  test('only enabled plugins appear in the tooltip', async () => {
    projectLintConfigData = lintConfigWith({ markdownlint: true, frontmatter: false });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
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
    expect(screen.queryByTestId('problems-no-plugins')).toBeNull();
    expect(screen.getByText(/does not resolve/)).toBeTruthy();
  });

  test('renders local-target prose from structured evidence instead of server English', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[
          diag({
            source: 'links',
            code: 'dead-link',
            message: 'opaque server fallback',
            localTarget: {
              href: './missing.png',
              targetKind: 'file',
              role: 'image',
              sourceForm: 'markdown-inline',
              resolvedTarget: 'missing.png',
              reason: 'no-such-file',
              resolutionMethod: 'source-relative',
            },
          }),
        ]}
      />,
    );
    expect(
      screen.getByText('Image target "missing.png" does not resolve to an existing file.'),
    ).toBeTruthy();
    expect(screen.queryByText('opaque server fallback')).toBeNull();
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

  test('doc-scope Auto-fix renders when onAutoFix is provided and calls it on click', () => {
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
    const onAutoFix = vi.fn(() => {});
    render(
      <ProblemsPanel docName="notes" diagnostics={[fixable, unfixable]} onAutoFix={onAutoFix} />,
    );
    const button = screen.getByTestId('problems-auto-fix') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('(1)');
    button.click();
    expect(onAutoFix).toHaveBeenCalledTimes(1);
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
    expect(askButtons).toHaveLength(2);
    askButtons[1]?.click();
    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect((onAskAi.mock.calls[0] as unknown[])[0]).toMatchObject({ code: 'MD025' });
    unmount();

    render(<ProblemsPanel docName="notes" diagnostics={[fixable, unfixable]} />);
    expect(screen.queryByTestId('problems-ask-ai')).toBeNull();
  });

  test('doc-scope Auto-fix is disabled when no diagnostic is fixable', () => {
    const onAutoFix = vi.fn(() => {});
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[diag({ code: 'MD025', message: 'Multiple H1' })]}
        onAutoFix={onAutoFix}
      />,
    );
    const disabledButton = screen.getByTestId('problems-auto-fix') as HTMLButtonElement;
    expect(disabledButton.disabled).toBe(true);
    expect(disabledButton.textContent).toContain('(0)');
  });

  test('doc-scope Auto-fix is absent without onAutoFix or without diagnostics', () => {
    const { unmount } = render(<ProblemsPanel docName="notes" diagnostics={[diag({})]} />);
    expect(screen.queryByTestId('problems-auto-fix')).toBeNull();
    unmount();
    render(<ProblemsPanel docName="notes" diagnostics={[]} onAutoFix={vi.fn(() => {})} />);
    expect(screen.queryByTestId('problems-auto-fix')).toBeNull();
  });

  test('doc-scope Fix all with AI counts every problem, not the unfixable remainder', () => {
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
    const onFixWithAi = vi.fn(() => {});
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[fixable, unfixable]}
        onAutoFix={vi.fn(() => {})}
        onFixWithAi={onFixWithAi}
      />,
    );
    const aiButton = screen.getByTestId('problems-fix-with-ai') as HTMLButtonElement;
    expect(screen.getByTestId('problems-auto-fix').textContent).toContain('(1)');
    expect(aiButton.textContent).toContain('(2)');
    expect(aiButton.disabled).toBe(false);
  });

  test('doc-scope Fix all with AI reports its scope and ships no diagnostics', () => {
    const onFixWithAi = vi.fn(() => {});
    render(
      <ProblemsPanel
        docName="nested/notes"
        diagnostics={[diag({ line: 9, code: 'MD025' }), diag({ line: 2, code: 'MD010' })]}
        onFixWithAi={onFixWithAi}
      />,
    );
    screen.getByTestId('problems-fix-with-ai').click();
    expect(onFixWithAi.mock.calls).toEqual([['doc']]);
  });

  test('doc-scope Fix all with AI is withheld on web (no onFixWithAi)', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[diag({})]}
        onAutoFix={vi.fn(() => {})}
        onAskAi={undefined}
      />,
    );
    expect(screen.queryByTestId('problems-fix-with-ai')).toBeNull();
  });

  test('the actions row renders for AI alone when nothing is deterministically fixable', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[diag({ code: 'MD025' })]}
        onFixWithAi={vi.fn(() => {})}
      />,
    );
    expect(screen.queryByTestId('problems-auto-fix')).toBeNull();
    expect((screen.getByTestId('problems-fix-with-ai') as HTMLButtonElement).disabled).toBe(false);
  });

  test('disabled Auto-fix names the reason in its accessible name', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[diag({ code: 'MD025' })]}
        onAutoFix={vi.fn(() => {})}
        onFixWithAi={vi.fn(() => {})}
      />,
    );
    const button = screen.getByTestId('problems-auto-fix') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toContain('no problems here have an automatic fix');
  });

  test('the nothing-fixable tooltip withholds the AI pointer on web', async () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[diag({ code: 'MD025', message: 'Multiple H1' })]}
        onAutoFix={vi.fn(() => {})}
      />,
    );
    fireEvent.focus(screen.getByTestId('problems-auto-fix').parentElement as HTMLElement);
    const tip = await screen.findByTestId('problems-auto-fix-tip');
    expect(tip.textContent).toContain('None of these problems have an automatic fix');
    expect(tip.textContent).not.toMatch(/Fix all with AI/);
  });

  test('the nothing-fixable tooltip keeps the AI pointer when that button exists', async () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[diag({ code: 'MD025', message: 'Multiple H1' })]}
        onAutoFix={vi.fn(() => {})}
        onFixWithAi={vi.fn(() => {})}
      />,
    );
    fireEvent.focus(screen.getByTestId('problems-auto-fix').parentElement as HTMLElement);
    const tip = await screen.findByTestId('problems-auto-fix-tip');
    expect(tip.textContent).toContain('Try Fix all with AI');
  });

  test('renders a row per diagnostic, sorted by line', () => {
    const diagnostics = [
      diag({ code: 'MD012', message: 'Multiple blanks', line: 9 }),
      diag({ code: 'MD010', message: 'Hard tabs', line: 2 }),
    ];
    render(<ProblemsPanel docName="notes" diagnostics={diagnostics} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain('MD010');
    expect(buttons[1]?.textContent).toContain('MD012');
  });

  test('clicking a row dispatches LINT_NAV_EVENT with the line', () => {
    let received: LintNavDetail | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<LintNavDetail>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName="notes" diagnostics={[diag({ line: 7, column: 2 })]} />);
      fireEvent.click(screen.getByRole('button'));
      expect(received).toEqual({
        docName: 'notes',
        line: 7,
        column: 2,
        source: 'markdownlint',
      });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('every row names the validator that produced it, not a generic category', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[
          diag({ line: 2 }),
          diag({ line: 3, source: 'frontmatter', code: 'required', message: 'Missing title' }),
          linkDiag({ line: 5 }),
        ]}
      />,
    );
    const tags = screen.getAllByTestId('problems-source-tag');
    expect(tags.map((tag) => tag.textContent)).toEqual(['markdownlint', 'frontmatter', 'links']);
    const row = screen.getByRole('button', { name: /Hard tabs/ });
    expect(row.textContent).toContain('MD010 · line 2');
    expect(row.textContent).not.toContain('markdownlint/MD010');
  });

  test('repeated findings collapse into one row with an instance count', () => {
    const repeated = [4, 9, 12].map((line) =>
      diag({
        line,
        source: 'frontmatter',
        code: 'required',
        message: 'Frontmatter property is missing',
      }),
    );
    render(<ProblemsPanel docName="notes" diagnostics={[...repeated, diag({ line: 2 })]} />);
    const groups = screen.getAllByTestId('problems-duplicate-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain('3 instances');
    expect(screen.queryByTestId('problems-duplicate-instances')).toBeNull();
    expect(screen.getAllByText('Frontmatter property is missing')).toHaveLength(1);
    expect(groups[0]?.textContent).toContain('required');
    expect(groups[0]?.textContent).not.toMatch(/line \d/);
  });

  test('expanding a group lists each occurrence, and one click jumps to its line', () => {
    let received: LintNavDetail | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<LintNavDetail>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(
        <ProblemsPanel
          docName="notes"
          diagnostics={[4, 9].map((line) => diag({ line, message: 'Hard tabs' }))}
        />,
      );
      fireEvent.click(
        screen.getByTestId('problems-duplicate-group').querySelector('button') as HTMLElement,
      );
      const occurrences = screen
        .getByTestId('problems-duplicate-instances')
        .querySelectorAll('button');
      expect(occurrences).toHaveLength(2);
      expect(occurrences[1]?.getAttribute('aria-label')).toBe('Hard tabs at line 9');
      fireEvent.click(occurrences[1] as HTMLElement);
      expect(received).toEqual({
        docName: 'notes',
        line: 9,
        column: 1,
        source: 'markdownlint',
      });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('an expanded occurrence keeps its own Fix action', () => {
    const fixAt = (line: number) =>
      diag({
        line,
        fixes: [
          {
            range: {
              start: { line: line - 1, character: 0 },
              end: { line: line - 1, character: 1 },
            },
            newText: '  ',
          },
        ],
      });
    const onFix = vi.fn(() => {});
    render(<ProblemsPanel docName="notes" diagnostics={[fixAt(4), fixAt(9)]} onFix={onFix} />);
    expect(screen.queryByTestId('problems-fix')).toBeNull();
    fireEvent.click(
      screen.getByTestId('problems-duplicate-group').querySelector('button') as HTMLElement,
    );
    const fixButtons = screen.getAllByTestId('problems-fix');
    expect(fixButtons).toHaveLength(2);
    fixButtons[1]?.click();
    expect(onFix).toHaveBeenCalledTimes(1);
    expect((onFix.mock.calls[0] as unknown[])[0]).toMatchObject({
      range: { start: { line: 8, character: 0 } },
    });
  });

  test('an expanded group exposes an Ask AI action per occurrence', () => {
    const onAskAi = vi.fn(() => {});
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[4, 9].map((line) => diag({ line, message: 'Hard tabs' }))}
        onAskAi={onAskAi}
      />,
    );
    expect(screen.queryByTestId('problems-ask-ai')).toBeNull();
    fireEvent.click(
      screen.getByTestId('problems-duplicate-group').querySelector('button') as HTMLElement,
    );
    expect(screen.getAllByTestId('problems-ask-ai')).toHaveLength(2);
  });

  test('same message from different rules stays ungrouped', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[
          diag({ line: 2, code: 'MD010', message: 'Same text' }),
          diag({ line: 5, code: 'MD012', message: 'Same text' }),
        ]}
      />,
    );
    expect(screen.queryByTestId('problems-duplicate-group')).toBeNull();
    expect(screen.getAllByText('Same text')).toHaveLength(2);
  });

  test('dead links to different targets stay ungrouped', () => {
    const deadLinkTo = (line: number, target: string) => ({
      ...linkDiag({ line }),
      linkTarget: target,
      message: `Link target "${target}" does not resolve to an existing document.`,
    });
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[deadLinkTo(2, 'alpha'), deadLinkTo(5, 'beta')]}
      />,
    );
    expect(screen.queryByTestId('problems-duplicate-group')).toBeNull();
    expect(screen.getAllByTestId('problems-create-page')).toHaveLength(2);
  });

  test('dead links to one target group, and each occurrence keeps its Create action', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[linkDiag({ line: 3 }), linkDiag({ line: 8 })]}
      />,
    );
    const group = screen.getByTestId('problems-duplicate-group');
    expect(screen.queryByTestId('problems-create-page')).toBeNull();
    fireEvent.click(group.querySelector('button') as HTMLElement);
    expect(screen.getAllByTestId('problems-create-page')).toHaveLength(2);
  });

  test('a dead-link row offers the one-shot Create page action; lint rows do not', async () => {
    render(<ProblemsPanel docName="notes" diagnostics={[linkDiag({ line: 5 }), diag({})]} />);
    const createButtons = screen.getAllByTestId('problems-create-page');
    expect(createButtons).toHaveLength(1);

    fireEvent.click(createButtons[0] as HTMLElement);
    await waitFor(() =>
      expect(createPageCalls).toEqual([{ initialDir: '', suggestedName: 'ghost' }]),
    );
    expect(addPageCalls).toEqual(['ghost']);
  });

  test('the create action is never counted by Auto-fix', () => {
    render(
      <ProblemsPanel docName="notes" diagnostics={[linkDiag({})]} onAutoFix={vi.fn(() => {})} />,
    );
    const button = screen.getByTestId('problems-auto-fix') as HTMLButtonElement;
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
      expect(received).toEqual({ docName: 'notes', line: 5, column: 1, source: 'links' });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('clicking a row banks a pending lint intent for later source-mode activation', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[diag({ line: 7, column: 2 })]} />);
    fireEvent.click(screen.getByRole('button'));
    expect(consumePendingSourceNavigation('notes')).toEqual({
      kind: 'lint',
      detail: { docName: 'notes', line: 7, column: 2, source: 'markdownlint' },
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
    expect(auditCalls).toBe(0);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(auditCalls).toBe(1);

    expect(screen.getByText('notes.md')).toBeTruthy();
    const groups = screen.getAllByTestId('problems-audit-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.getAttribute('data-state')).toBe('closed');
    expect(groups[0]?.querySelector('[data-testid="problems-audit-file-count"]')?.textContent).toBe(
      '2',
    );
    expect(screen.queryByText('Heading increment')).toBeNull();
    expandGroup('guides/setup.md');
    expect(screen.getByText('Heading increment')).toBeTruthy();
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
    expandGroup('guides/setup.md');

    const tags = screen.getAllByTestId('problems-source-tag');
    expect(tags.map((tag) => tag.textContent)).toEqual(['markdownlint', 'links']);
    expect(screen.getByTestId('problems-audit-summary').textContent).toContain('1 error');
    expect(screen.getByTestId('problems-audit-summary').textContent).toContain('1 warning');
  });

  test('repeats collapse inside a file group while the file count stays the total', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          {
            file: 'guides/setup.md',
            diagnostics: [2, 6, 11].map((line) =>
              diag({ line, source: 'frontmatter', code: 'required', message: 'Missing title' }),
            ),
          },
        ],
        warningCount: 3,
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());

    expect(screen.getByTestId('problems-audit-file-count').textContent).toBe('3');
    expandGroup('guides/setup.md');
    expect(screen.getAllByTestId('problems-duplicate-group')).toHaveLength(1);
    expect(screen.getAllByText('Missing title')).toHaveLength(1);
  });

  test('the refresh icon explains itself in a tooltip', async () => {
    runLintAuditImpl = async () => auditResult({ fileCount: 2 });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() =>
      expect((screen.getByTestId('problems-audit-refresh') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.focus(screen.getByTestId('problems-audit-refresh'));
    const tooltip = await screen.findByTestId('problems-audit-refresh-tooltip');
    expect(tooltip.textContent).toContain('Re-run the project audit');
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

    expandGroup('guides/setup.md');
    fireEvent.click(screen.getByTestId('problems-create-page'));
    await waitFor(() =>
      expect(createPageCalls).toEqual([{ initialDir: '', suggestedName: 'ghost' }]),
    );
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
    expect(screen.getByText('first.md')).toBeTruthy();
    expect(auditCalls).toBe(1);

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'second.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
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
    expect((screen.getByLabelText('Re-run the project audit') as HTMLButtonElement).disabled).toBe(
      true,
    );

    resolveAudit(auditResult({ fileCount: 2 }));
    await waitFor(() => expect(screen.getByText('No problems across 2 documents.')).toBeTruthy());
    expect((screen.getByLabelText('Re-run the project audit') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test('a failed audit surfaces the error and refresh retries it', async () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() =>
      expect(screen.getByText('The audit could not be completed. Try again.')).toBeTruthy(),
    );

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'retried.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
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
      expandGroup('guides/setup.md');

      fireEvent.click(screen.getByRole('button', { name: /Hard tabs/ }));

      expect(window.location.hash).toBe('#/guides/setup');
      expect(consumePendingSourceNavigation('guides/setup')).toEqual({
        kind: 'lint',
        detail: {
          docName: 'guides/setup',
          line: 4,
          column: 2,
          source: 'markdownlint',
        },
      });
      expect(navEvents).toBe(0);
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('a grouped project-scope occurrence banks the clicked line, not the group first', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          {
            file: 'guides/setup.md',
            diagnostics: [4, 9].map((line) =>
              diag({
                line,
                source: 'frontmatter',
                code: 'required',
                message: 'Frontmatter property is missing',
              }),
            ),
          },
        ],
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

      expandGroup('guides/setup.md');
      fireEvent.click(
        screen.getByTestId('problems-duplicate-group').querySelector('button') as HTMLElement,
      );
      const occurrences = screen
        .getByTestId('problems-duplicate-instances')
        .querySelectorAll('button');
      expect(occurrences).toHaveLength(2);
      fireEvent.click(occurrences[1] as HTMLElement);

      expect(window.location.hash).toBe('#/guides/setup');
      expect(consumePendingSourceNavigation('guides/setup')).toEqual({
        kind: 'lint',
        detail: {
          docName: 'guides/setup',
          line: 9,
          column: 1,
          source: 'frontmatter',
        },
      });
      expect(navEvents).toBe(0);
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('clicking a project-scope diagnostic for the open doc keeps the in-doc event fast path', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'notes.md', diagnostics: [diag({ line: 7, column: 2 })] }] });
    let received: LintNavDetail | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<LintNavDetail>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName="notes" diagnostics={[]} />);
      fireEvent.click(screen.getByTestId('panel-scope-project'));
      await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy());
      expandGroup('notes.md');
      const hashBefore = window.location.hash;

      fireEvent.click(screen.getByRole('button', { name: /Hard tabs/ }));

      expect(received).toEqual({
        docName: 'notes',
        line: 7,
        column: 2,
        source: 'markdownlint',
      });
      expect(window.location.hash).toBe(hashBefore);
      expect(consumePendingSourceNavigation('notes')).toEqual({
        kind: 'lint',
        detail: { docName: 'notes', line: 7, column: 2, source: 'markdownlint' },
      });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('project Auto-fix sweeps only fixable files, re-audits, and reports completion', async () => {
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

    expect(screen.getByTestId('problems-auto-fix').textContent).toContain('(2)');
    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(fixLintDocCalls).toEqual(['a', 'nested/c']));
    await waitFor(() => expect(auditCalls).toBe(2));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0]?.[0])).toContain('2 files');
    expect(toastError).not.toHaveBeenCalled();
  });

  test('Stop ends a running project sweep and leaves earlier fixes in place', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          { file: 'a.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
          { file: 'b.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
          { file: 'c.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
        ],
      });
    let releaseFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fixLintDocImpl = async (docName: string) => {
      if (docName === 'a') await firstInFlight;
      return { ok: true as const, status: 200, problemType: null, errorDetail: null };
    };

    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    const stop = await screen.findByTestId('problems-cancel-fix');
    fireEvent.click(stop);
    releaseFirst?.();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(fixLintDocCalls).toEqual(['a']);
    expect(String(toastInfo.mock.calls[0]?.[0])).toContain('already fixed stay fixed');
    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('problems-cancel-fix')).toBeNull());
    await waitFor(() => expect(auditCalls).toBe(2));
  });

  test('a running sweep survives the panel unmounting and still reports how it ended', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          { file: 'a.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
          { file: 'b.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
          { file: 'c.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
        ],
      });
    let releaseFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fixLintDocImpl = async (docName: string) => {
      if (docName === 'a') await firstInFlight;
      return { ok: true as const, status: 200, problemType: null, errorDetail: null };
    };

    const view = render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await screen.findByTestId('problems-cancel-fix');
    view.unmount();
    releaseFirst?.();

    await waitFor(() => expect(fixLintDocCalls).toEqual(['a', 'b', 'c']));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    expect(auditCalls).toBe(1);
  });

  test('a stopped sweep does not poison the next one', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          { file: 'a.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
          { file: 'b.md', diagnostics: [diag({ fixes: [fixableEdit] })] },
        ],
      });
    let releaseFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fixLintDocImpl = async (docName: string) => {
      if (docName === 'a') await firstInFlight;
      return { ok: true as const, status: 200, problemType: null, errorDetail: null };
    };

    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    fireEvent.click(await screen.findByTestId('problems-cancel-fix'));
    releaseFirst?.();
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(fixLintDocCalls).toEqual(['a']);

    fixLintDocCalls.length = 0;
    fixLintDocImpl = async () => ({
      ok: true as const,
      status: 200,
      problemType: null,
      errorDetail: null,
    });
    await waitFor(() =>
      expect((screen.getByTestId('problems-auto-fix') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(fixLintDocCalls).toEqual(['a', 'b']));
  });

  test('project Auto-fix continues past per-file failures and surfaces one error toast', async () => {
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

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(fixLintDocCalls).toEqual(['bad', 'good']));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(String(toastError.mock.calls[0]?.[0])).toContain('1 of 2');
    const options = toastError.mock.calls[0]?.[1] as { description?: string } | undefined;
    expect(options?.description).toBe('bad.md — conflict');
  });

  test('project Auto-fix retries a capacity refusal and reports no failure', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'busy.md', diagnostics: [diag({ fixes: [fixableEdit] })] }] });
    const outcomes = [
      {
        ok: false,
        errorDetail: 'Too many agent sessions',
        status: 503,
        problemType: 'urn:ok:error:too-many-agent-sessions',
      },
      { ok: true },
    ];
    fixLintDocImpl = async () => outcomes.shift() ?? { ok: true };
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('busy.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(fixLintDocCalls).toEqual(['busy', 'busy']));
    expect(toastError).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const options = toastError.mock.calls[0]?.[1] as { description?: string } | undefined;
    expect(options?.description).toBe('bad.md');
  });

  test('project Auto-fix is disabled while loading and when nothing is fixable', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [{ file: 'plain.md', diagnostics: [diag({ code: 'MD025' })] }],
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('plain.md')).toBeTruthy());
    expect((screen.getByTestId('problems-auto-fix') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    expect(fixLintDocCalls).toEqual([]);
  });

  test('project Fix all with AI reports the project scope once the audit loads', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          { file: 'a.md', diagnostics: [diag({ line: 1, code: 'MD010' })] },
          {
            file: 'nested/c.md',
            diagnostics: [diag({ line: 4, code: 'MD025' }), diag({ line: 7, code: 'MD013' })],
          },
        ],
      });
    const onFixWithAi = vi.fn(() => {});
    render(<ProblemsPanel docName="notes" diagnostics={[]} onFixWithAi={onFixWithAi} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());

    expect(screen.getByTestId('problems-fix-with-ai').textContent).toContain('(3)');
    fireEvent.click(screen.getByTestId('problems-fix-with-ai'));
    expect(onFixWithAi.mock.calls).toEqual([['project']]);
  });

  test('project Fix all with AI stays hidden until the audit has something to describe', async () => {
    runLintAuditImpl = async () => auditResult({ files: [], fileCount: 3 });
    render(<ProblemsPanel docName="notes" diagnostics={[]} onFixWithAi={vi.fn(() => {})} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByTestId('problems-audit-summary')).toBeTruthy());
    expect(screen.queryByTestId('problems-fix-with-ai')).toBeNull();
  });

  test('a clean project audit makes no claim about problems lacking an automatic fix', async () => {
    runLintAuditImpl = async () => auditResult({ files: [], fileCount: 3 });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('No problems across 3 documents.')).toBeTruthy());

    const button = screen.getByTestId('problems-auto-fix');
    fireEvent.focus(button.parentElement as HTMLElement);
    const tip = await screen.findByTestId('problems-auto-fix-tip');
    expect(tip.textContent).not.toMatch(/None of these problems/);
    expect(tip.textContent).not.toMatch(/Fix all with AI/);
    expect(button.getAttribute('aria-label')).not.toContain(
      'no problems here have an automatic fix',
    );
    expect(button.getAttribute('aria-label')).toBe('Auto-fix — nothing to fix');
  });

  test('project Fix all with AI is disabled mid-sweep and usable again once it ends', async () => {
    const fixableEdit = {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      newText: '  ',
    };
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'a.md', diagnostics: [diag({ fixes: [fixableEdit] })] }] });
    let releaseFix: (() => void) | undefined;
    fixLintDocImpl = async () => {
      await new Promise<void>((resolve) => {
        releaseFix = resolve;
      });
      return { ok: true };
    };
    render(<ProblemsPanel docName="notes" diagnostics={[]} onFixWithAi={vi.fn(() => {})} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() =>
      expect((screen.getByTestId('problems-fix-with-ai') as HTMLButtonElement).disabled).toBe(true),
    );

    releaseFix?.();
    await waitFor(() =>
      expect((screen.getByTestId('problems-fix-with-ai') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    const autoFix = screen.getByTestId('problems-auto-fix') as HTMLButtonElement;
    expect(autoFix.disabled).toBe(false);
    expect(autoFix.textContent).not.toContain('Fixing');
    expect(autoFix.textContent).toContain('(1)');
  });

  test('doc-scope content and count stay doc-scoped while project scope is active', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'other.md', diagnostics: [diag({}), diag({ line: 9 })] }] });
    render(<ProblemsPanel docName="notes" diagnostics={[diag({ line: 1 })]} />);
    expect(screen.getByText('1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('other.md')).toBeTruthy());
    expect(screen.queryByText('1', { selector: '[data-slot="panel-count"]' })).toBeNull();

    fireEvent.click(screen.getByTestId('panel-scope-doc'));
    expect(screen.getByText('Hard tabs')).toBeTruthy();
  });

  test('a lint-config change refreshes a LOADED project snapshot in place', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'notes.md', diagnostics: [diag({})] }] });
    render(<ProblemsPanel docName="other" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(auditCalls).toBe(1));

    emitLintConfigChangedForTest();
    await waitFor(() => expect(auditCalls).toBe(2));
  });

  test('a lint-config change does NOT audit while the panel sits in doc scope', async () => {
    runLintAuditImpl = async () => auditResult();
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    emitLintConfigChangedForTest();
    emitLintConfigChangedForTest();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(auditCalls).toBe(0);
  });

  test('a lint-config change does not resurrect a snapshot the panel never loaded', async () => {
    runLintAuditImpl = async () => null;
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(auditCalls).toBe(1));
    await waitFor(() => expect(screen.getByText(/could not be completed/i)).toBeTruthy());

    emitLintConfigChangedForTest();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(auditCalls).toBe(1);
  });

  test('a superseded walk re-loads in place instead of surfacing an error', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'guides/setup.md', diagnostics: [diag({ line: 4 })] }] });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(auditCalls).toBe(1);

    runLintAuditImpl = async () => AUDIT_SUPERSEDED;
    emitLintConfigChangedForTest();
    await waitFor(() => expect(auditCalls).toBe(2));

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'guides/setup.md', diagnostics: [diag({ line: 4 })] }] });
    emitLintConfigChangedForTest();
    await waitFor(() => expect(auditCalls).toBe(3));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(screen.queryByText(/could not be completed/i)).toBeNull();
  });

  test('a superseded refresh leaves the panel on its previous plane, not a spinner', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'guides/setup.md', diagnostics: [diag({ line: 4 })] }] });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());

    runLintAuditImpl = async () => AUDIT_SUPERSEDED;
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
    await waitFor(() => expect(auditCalls).toBe(2));

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Re-run the project audit') as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByText('guides/setup.md')).toBeTruthy();
    expect(screen.queryByText(/could not be completed/i)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'after-retry.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
    await waitFor(() => expect(screen.getByText('after-retry.md')).toBeTruthy());
  });

  test('a first activation that is superseded offers the retry rather than spinning', async () => {
    runLintAuditImpl = async () => AUDIT_SUPERSEDED;
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));

    await waitFor(() =>
      expect(screen.getByText('The audit could not be completed. Try again.')).toBeTruthy(),
    );
    expect((screen.getByLabelText('Re-run the project audit') as HTMLButtonElement).disabled).toBe(
      false,
    );

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'retried.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
    await waitFor(() => expect(screen.getByText('retried.md')).toBeTruthy());
  });

  test('a superseded walk never overwrites a replacement load that started after it', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'first.md', diagnostics: [diag({})] }] });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('first.md')).toBeTruthy());

    let releaseSuperseded: () => void = () => {};
    runLintAuditImpl = () =>
      new Promise((resolve) => {
        releaseSuperseded = () => resolve(AUDIT_SUPERSEDED);
      });
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
    await waitFor(() => expect(auditCalls).toBe(2));

    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'second.md', diagnostics: [diag({})] }] });
    emitLintConfigChangedForTest();
    await waitFor(() => expect(screen.getByText('second.md')).toBeTruthy());

    releaseSuperseded();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('second.md')).toBeTruthy();
    expect(screen.queryByText('first.md')).toBeNull();
  });
});

describe('ProblemsPanel — scoped tab requests', () => {
  async function showProjectScope() {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'guides/setup.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
  }

  test('a doc-scoped problems request pulls a project-scope panel back to this doc', async () => {
    render(
      <ProblemsPanel docName="notes" diagnostics={[diag({ line: 1, message: 'Hard tabs' })]} />,
    );
    await showProjectScope();

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));

    expect(screen.queryByTestId('problems-project-scope')).toBeNull();
    expect(screen.getByTestId('panel-scope-doc').getAttribute('data-state')).toBe('on');
    expect(screen.getByText('Hard tabs')).toBeTruthy();
  });

  test('leaves the scope alone for another tab and for a request carrying no scope', async () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    await showProjectScope();

    act(() => requestDocPanelTab('comments', { scope: 'doc' }));
    expect(screen.getByTestId('problems-project-scope')).toBeTruthy();

    act(() => requestDocPanelTab('problems'));
    expect(screen.getByTestId('problems-project-scope')).toBeTruthy();
  });

  test('scope and keyboard focus named before the panel existed reach it on mount', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'guides/setup.md', diagnostics: [diag({})] }] });
    act(() => requestDocPanelTab('problems', { scope: 'project', focus: 'panel' }));

    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(screen.getByTestId('panel-scope-project').getAttribute('data-state')).toBe('on');
    expect(document.activeElement).toBe(screen.getByTestId('problems-panel'));
  });

  test('pointer-style requests preserve focus while keyboard requests move it to the panel', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    const prior = document.createElement('button');
    document.body.appendChild(prior);
    prior.focus();

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));
    expect(document.activeElement).toBe(prior);

    act(() => requestDocPanelTab('problems', { scope: 'doc', focus: 'panel' }));
    expect(document.activeElement).toBe(screen.getByTestId('problems-panel'));
    prior.remove();
  });

  test('a latched scope is spent once, not re-applied to the next panel', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'guides/setup.md', diagnostics: [diag({})] }] });
    act(() => requestDocPanelTab('problems', { scope: 'project' }));
    const first = render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    first.unmount();

    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    expect(screen.getByTestId('panel-scope-doc').getAttribute('data-state')).toBe('on');
  });

  test('a live panel consumes the scope, leaving nothing for the next mount', async () => {
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    await showProjectScope();

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));
    cleanup();
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    expect(screen.getByTestId('panel-scope-doc').getAttribute('data-state')).toBe('on');
  });

  test('stops honoring scoped requests once the panel unmounts', () => {
    runLintAuditImpl = async () => auditResult();
    const { unmount } = render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    unmount();

    act(() => requestDocPanelTab('problems', { scope: 'project' }));

    expect(auditCalls).toBe(0);
  });
});

describe('ProblemsPanel — project scope: collapse and expand-all', () => {
  const twoFileAudit = () =>
    auditResult({
      files: [
        {
          file: 'guides/setup.md',
          diagnostics: [diag({ code: 'MD001', message: 'Heading increment', line: 8 })],
        },
        { file: 'notes.md', diagnostics: [diag({ line: 2, message: 'Hard tabs' })] },
      ],
      fileCount: 5,
      warningCount: 2,
    });

  test('file groups mount collapsed: headers with counts, contents unmounted', async () => {
    runLintAuditImpl = async () => twoFileAudit();
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());

    const groups = screen.getAllByTestId('problems-audit-group');
    expect(groups).toHaveLength(2);
    for (const group of groups) expect(group.getAttribute('data-state')).toBe('closed');
    expect(screen.queryByText('Heading increment')).toBeNull();
    expect(screen.queryByTestId('problems-source-tag')).toBeNull();
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(groups[0]?.querySelector('[data-testid="problems-audit-file-count"]')?.textContent).toBe(
      '1',
    );
    expect(screen.getByTestId('problems-audit-expand-toggle').getAttribute('aria-label')).toBe(
      'Expand all file groups',
    );
  });

  test('expand-all opens every group and mounts its rows; collapse-all closes them', async () => {
    runLintAuditImpl = async () => twoFileAudit();
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-audit-expand-toggle'));
    for (const group of screen.getAllByTestId('problems-audit-group'))
      expect(group.getAttribute('data-state')).toBe('open');
    expect(screen.getByText('Heading increment')).toBeTruthy();
    expect(screen.getByText('Hard tabs')).toBeTruthy();
    expect(screen.getByTestId('problems-audit-expand-toggle').getAttribute('aria-label')).toBe(
      'Collapse all file groups',
    );

    fireEvent.click(screen.getByTestId('problems-audit-expand-toggle'));
    for (const group of screen.getAllByTestId('problems-audit-group'))
      expect(group.getAttribute('data-state')).toBe('closed');
    expect(screen.queryByText('Heading increment')).toBeNull();
    expect(screen.getByTestId('problems-audit-expand-toggle').getAttribute('aria-label')).toBe(
      'Expand all file groups',
    );
  });

  test('a single group expands on its own without opening the others', async () => {
    runLintAuditImpl = async () => twoFileAudit();
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());

    expandGroup('guides/setup.md');
    const groups = screen.getAllByTestId('problems-audit-group');
    const setup = groups.find((g) => g.textContent?.includes('guides/setup.md'));
    const notes = groups.find((g) => g.textContent?.includes('notes.md'));
    expect(setup?.getAttribute('data-state')).toBe('open');
    expect(notes?.getAttribute('data-state')).toBe('closed');
    expect(screen.getByText('Heading increment')).toBeTruthy();
    expect(screen.queryByText('Hard tabs')).toBeNull();
    expect(screen.getByTestId('problems-audit-expand-toggle').getAttribute('aria-label')).toBe(
      'Expand all file groups',
    );
  });

  test('the expand/collapse-all control is absent when the audit is clean', async () => {
    runLintAuditImpl = async () => auditResult({ files: [], fileCount: 3 });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('No problems across 3 documents.')).toBeTruthy());
    expect(screen.queryByTestId('problems-audit-expand-toggle')).toBeNull();
  });
});

describe('ProblemsPanel — project scope: sweep-progress live region', () => {
  const fixableEdit = {
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
    newText: '  ',
  };

  test('a role=status region announces the running count while sweeping and retires when it ends', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'solo.md', diagnostics: [diag({ fixes: [fixableEdit] })] }] });
    let releaseFix: (() => void) | undefined;
    fixLintDocImpl = () =>
      new Promise<{ ok: true }>((resolve) => {
        releaseFix = () => resolve({ ok: true });
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('solo.md')).toBeTruthy());

    expect(sweepLiveRegion()).toBeUndefined();

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(sweepLiveRegion()?.textContent).toBe('Fixing 0 of 1 files'));
    expect(sweepLiveRegion()?.getAttribute('role')).toBe('status');

    releaseFix?.();
    await waitFor(() => expect(sweepLiveRegion()).toBeUndefined());
  });

  test('the announced count advances as the sweep progresses', async () => {
    const total = SWEEP_PROGRESS_CHUNK + 1;
    const interval = sweepProgressInterval(total);
    const lastInteriorFlush = Math.floor((total - 1) / interval) * interval;
    runLintAuditImpl = async () =>
      auditResult({
        files: Array.from({ length: total }, (_, i) => ({
          file: `f${i}.md`,
          diagnostics: [diag({ fixes: [fixableEdit] })],
        })),
      });
    let releaseLast: (() => void) | undefined;
    fixLintDocImpl = () =>
      new Promise<{ ok: true }>((resolve) => {
        if (fixLintDocCalls.length === total) releaseLast = () => resolve({ ok: true });
        else resolve({ ok: true });
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('f0.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(sweepLiveRegion()?.textContent).toBe(`Fixing 0 of ${total} files`));
    await waitFor(
      () =>
        expect(sweepLiveRegion()?.textContent).toBe(
          `Fixing ${lastInteriorFlush} of ${total} files`,
        ),
      { timeout: 10_000 },
    );

    await waitFor(() => expect(fixLintDocCalls.length).toBe(total));
    releaseLast?.();
    await waitFor(() => expect(sweepLiveRegion()).toBeUndefined());
  });

  test('the region announces at chunk granularity, not once per file', async () => {
    const total = 11;
    expect(sweepProgressInterval(total)).toBe(2);
    runLintAuditImpl = async () =>
      auditResult({
        files: Array.from({ length: total }, (_, i) => ({
          file: `f${i}.md`,
          diagnostics: [diag({ fixes: [fixableEdit] })],
        })),
      });
    const parked: Array<() => void> = [];
    fixLintDocImpl = () =>
      new Promise<{ ok: true }>((resolve) => {
        if (fixLintDocCalls.length <= 3) parked.push(() => resolve({ ok: true }));
        else resolve({ ok: true });
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('f0.md')).toBeTruthy());

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    await waitFor(() => expect(sweepLiveRegion()?.textContent).toBe(`Fixing 0 of ${total} files`));
    await waitFor(() => expect(fixLintDocCalls.length).toBe(1));

    parked[0]?.();
    await waitFor(() => expect(fixLintDocCalls.length).toBe(2));
    expect(sweepLiveRegion()?.textContent).toBe(`Fixing 0 of ${total} files`);

    parked[1]?.();
    await waitFor(() => expect(sweepLiveRegion()?.textContent).toBe(`Fixing 2 of ${total} files`));

    await waitFor(() => expect(fixLintDocCalls.length).toBe(3));
    parked[2]?.();
    await waitFor(() => expect(sweepLiveRegion()).toBeUndefined());
  });
});

describe('ProblemsPanel — local-target findings', () => {
  const fileLink = (line: number) =>
    localTargetDiag({
      line,
      role: 'link',
      targetKind: 'file',
      resolvedTarget: 'docs/spec.pdf',
      message: 'Link target "docs/spec.pdf" does not resolve to an existing file.',
    });
  const imageEmbed = (line: number) =>
    localTargetDiag({
      line,
      role: 'image',
      targetKind: 'file',
      resolvedTarget: 'assets/logo.png',
      message: 'Image target "assets/logo.png" does not resolve to an existing file.',
    });
  const unresolvableLink = (line: number) =>
    localTargetDiag({
      line,
      role: 'link',
      targetKind: 'unknown',
      reason: 'unresolvable',
      message: 'Link target "../../etc/passwd" could not be resolved to a project-local target.',
    });

  test('reads file, image, unresolvable, and document kinds apart from the evidence', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[
          diag({ line: 1 }),
          linkDiag({ line: 2 }),
          fileLink(3),
          imageEmbed(4),
          unresolvableLink(5),
        ]}
      />,
    );
    const tags = screen.getAllByTestId('problems-source-tag');
    expect(tags.map((tag) => tag.textContent)).toEqual([
      'markdownlint',
      'links',
      'links',
      'links',
      'links',
    ]);
    expect(tags.map((tag) => tag.getAttribute('data-target-kind'))).toEqual([
      null,
      'document',
      'file',
      'image',
      'unresolvable',
    ]);
  });

  test('never offers Create page for file, image, or unresolvable findings', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[fileLink(3), imageEmbed(4), unresolvableLink(5), linkDiag({ line: 6 })]}
      />,
    );
    const created = screen.getAllByTestId('problems-create-page');
    expect(created).toHaveLength(1);
  });

  test('offers Create page for a reference-style missing document and creates that doc', async () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[
          localTargetDiag({
            line: 3,
            role: 'link',
            targetKind: 'document',
            sourceForm: 'markdown-reference',
            resolvedTarget: 'guides/setup',
            reason: 'no-such-doc',
            linkTarget: 'guides/setup',
            message: 'Link target "guides/setup" does not resolve to an existing document.',
            definition: { line: 20, label: 'setup' },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('problems-source-tag').getAttribute('data-target-kind')).toBe(
      'document',
    );
    fireEvent.click(screen.getByTestId('problems-create-page'));
    await waitFor(() =>
      expect(createPageCalls).toEqual([{ initialDir: '', suggestedName: 'guides/setup' }]),
    );
    expect(addPageCalls).toEqual(['guides/setup']);
  });

  test('a stray create target on an image finding still surfaces no Create page', () => {
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[
          localTargetDiag({
            line: 3,
            role: 'image',
            targetKind: 'file',
            resolvedTarget: 'assets/logo.png',
            linkTarget: 'assets/logo.png',
            message: 'Image target "assets/logo.png" does not resolve to an existing file.',
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('problems-create-page')).toBeNull();
  });

  test('a file finding click-jumps to its authored occurrence', () => {
    let received: { docName: string; line: number; column: number } | null = null;
    const listener = (e: Event) => {
      received = (e as CustomEvent<LintNavDetail>).detail;
    };
    window.addEventListener(LINT_NAV_EVENT, listener);
    try {
      render(<ProblemsPanel docName="notes" diagnostics={[fileLink(7)]} />);
      fireEvent.click(screen.getByRole('button', { name: /does not resolve to an existing file/ }));
      expect(received).toEqual({ docName: 'notes', line: 7, column: 1, source: 'links' });
    } finally {
      window.removeEventListener(LINT_NAV_EVENT, listener);
    }
  });

  test('keeps the finding message in the row accessible name and hides the kind glyph', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[imageEmbed(3)]} />);
    expect(
      screen.getByRole('button', {
        name: /Image target "assets\/logo.png" does not resolve to an existing file/,
      }),
    ).toBeTruthy();
    const glyph = screen.getByTestId('problems-source-tag').querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  test('project file groups surface file and image findings with gated actions', async () => {
    runLintAuditImpl = async () =>
      auditResult({
        files: [
          {
            file: 'guides/setup.md',
            diagnostics: [linkDiag({ line: 2 }), fileLink(4), imageEmbed(6)],
          },
        ],
        fileCount: 1,
        warningCount: 3,
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expandGroup('guides/setup.md');

    const kinds = screen
      .getAllByTestId('problems-source-tag')
      .map((tag) => tag.getAttribute('data-target-kind'));
    expect(kinds).toEqual(['document', 'file', 'image']);
    expect(screen.getAllByTestId('problems-create-page')).toHaveLength(1);
  });

  test('repeated image findings to one target group and never offer Create', () => {
    render(<ProblemsPanel docName="notes" diagnostics={[imageEmbed(3), imageEmbed(8)]} />);
    const group = screen.getByTestId('problems-duplicate-group');
    expect(group.textContent).toContain('2 instances');
    expect(screen.getByTestId('problems-source-tag').getAttribute('data-target-kind')).toBe(
      'image',
    );
    expect(screen.queryByTestId('problems-create-page')).toBeNull();
    fireEvent.click(group.querySelector('button') as HTMLElement);
    expect(
      screen.getByTestId('problems-duplicate-instances').querySelectorAll('button'),
    ).toHaveLength(2);
    expect(screen.queryByTestId('problems-create-page')).toBeNull();
  });
});
