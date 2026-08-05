/**
 * Behavioral tests for ProblemsPanel: renders a row per diagnostic, shows the
 * empty state, and on row click dispatches a LINT_NAV_EVENT plus banks a
 * pending lint intent so the source editor can jump now or on its next
 * activation. Project scope runs the audit on demand (never on mount), caches
 * the result across scope flips, re-fetches only through the refresh
 * affordance, and click-navigates to the offending doc by hash.
 */

import type { LintDiagnostic, ValidationAuditResponse } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SWEEP_PROGRESS_CHUNK, sweepProgressInterval } from '@/components/problems-sweep';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { LintNavDetail } from './ProblemsPanel';

// Both lingui macro specifiers alias to ONE shim module under the vitest dom
// config, so two mock registrations race for a single resolved module id and
// only one factory survives. The factories must be the same superset object —
// a specifier-shaped split (t on core, components on react) loses whichever
// half the race drops (observed: useLingui vanishing when the core factory
// won).
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
/** Mirrors the client's exported sentinel; the mock below replaces the module. */
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
// Captured so a test can fire a config change the way a rule toggle does.
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
// The panel's project scope now consumes the unified audit plane.
vi.doMock('@/editor/validation-audit-client', () => ({
  AUDIT_SUPERSEDED,
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
// Dynamic like the panel above, not a static import: the store binds the mocked
// `sonner` only if it loads after the registrations, and a hoisted static import
// would bind the real one.
const { __resetProjectFixSweepForTests } = await import('@/lib/project-fix-sweep-store');
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
  toastInfo.mockClear();
  lintConfigListeners.clear();
  // The sweep is a session singleton now, and this config isolates per FILE,
  // not per test — without this a sweep left running by one test would refuse
  // the next test's start.
  __resetProjectFixSweepForTests();
});

afterEach(() => {
  cleanup();
  clearPendingSourceNavigationsForTest();
  __resetProjectFixSweepForTests();
  window.location.hash = '';
});

/**
 * Production mounts the panel under main.tsx's root TooltipProvider. The action
 * row's Auto-fix / Fix all with AI buttons always carry tooltips, so every
 * render here needs one — Radix throws without an ancestor provider.
 */
function render(ui: ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

/**
 * Open a collapsed project-scope file group. Groups mount collapsed, so a test
 * that reaches into a group's diagnostic rows must first click its header — the
 * file-path label lives inside the CollapsibleTrigger button.
 */
function expandGroup(filePath: string) {
  const header = screen.getByText(filePath);
  fireEvent.click(header.closest('button') ?? header);
}

/**
 * The sweep's screen-reader progress region: a role=status live region whose
 * text is the running "Fixing N of M files" count. Matched by that text so it is
 * never confused with the audit-loading skeleton, which is also role=status but
 * announces the audit rather than the sweep (the two are mutually exclusive by
 * construction, but querying on the text keeps the helper honest regardless).
 * Returns undefined when no sweep is running.
 */
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

  test('a compact Checked-by line reveals the active plugins in a tooltip', async () => {
    projectLintConfigData = lintConfigWith({ markdownlint: true, frontmatter: true });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
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
    // The label sizes the click before it happens: only the fixable diagnostic
    // counts, not the total problem count.
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
    // Empty state renders no action row at all.
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
    // The two buttons are "the mechanical subset" (1) and "the whole list" (2),
    // not two halves of a partition.
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
    // Scope only: the prompt names it and the agent reads its own list, so a
    // stale snapshot never travels with the hand-off.
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
    // Mike's case inverted: no Auto-fix affordance at all, but the panel still
    // offers an enabled action rather than looking inert.
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
    // The tooltip describes the wrapper span (a disabled button emits no
    // pointer events), so the name is all a screen-reader user gets.
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
    // The tooltip hangs off the wrapper span (a disabled button emits no
    // pointer events), so focus it rather than the control.
    fireEvent.focus(screen.getByTestId('problems-auto-fix').parentElement as HTMLElement);
    const tip = await screen.findByTestId('problems-auto-fix-tip');
    expect(tip.textContent).toContain('None of these problems have an automatic fix');
    // Pointing at a button that was never rendered sends the user hunting.
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
    // Lower line sorts first.
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
    // Each chip is the producing validator's own name, not a shared "lint"
    // label — so two different validators read as two distinct chips.
    expect(tags.map((tag) => tag.textContent)).toEqual(['markdownlint', 'frontmatter', 'links']);
    // The chip carries the producer, so the subline drops the duplicate prefix
    // and shows the bare rule code.
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
    // One collapsed group for the repeat, one plain row for the singleton.
    const groups = screen.getAllByTestId('problems-duplicate-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain('3 instances');
    // Collapsed by default: the occurrences are not in the tree yet.
    expect(screen.queryByTestId('problems-duplicate-instances')).toBeNull();
    // The message appears once, not three times.
    expect(screen.getAllByText('Frontmatter property is missing')).toHaveLength(1);
    // The collapsed header's subline shows the bare rule code — a group spans
    // many lines, so it names none of them.
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
      // Each occurrence keeps the message in its accessible name so it still
      // reads as a whole finding out of list context.
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
    // Collapsed, the group header carries no per-occurrence Fix.
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
    // Collapsed, the group header carries no per-occurrence Ask AI.
    expect(screen.queryByTestId('problems-ask-ai')).toBeNull();
    fireEvent.click(
      screen.getByTestId('problems-duplicate-group').querySelector('button') as HTMLElement,
    );
    // One Ask AI per expanded occurrence — the grouped path renders the same
    // per-occurrence actions as an ungrouped row.
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
    // Same source and code (`links`/`dead-link`), different target: the key's
    // target/message axis keeps them apart, so each keeps its own Create action.
    expect(screen.queryByTestId('problems-duplicate-group')).toBeNull();
    expect(screen.getAllByTestId('problems-create-page')).toHaveLength(2);
  });

  test('dead links to one target group, and each occurrence keeps its Create action', () => {
    // Same source, code, target and message: the group key collapses them, so the
    // Create action has to survive the grouped path, not just the plain-row one.
    render(
      <ProblemsPanel
        docName="notes"
        diagnostics={[linkDiag({ line: 3 }), linkDiag({ line: 8 })]}
      />,
    );
    const group = screen.getByTestId('problems-duplicate-group');
    // Collapsed, the header offers no per-occurrence Create.
    expect(screen.queryByTestId('problems-create-page')).toBeNull();
    fireEvent.click(group.querySelector('button') as HTMLElement);
    // One Create per expanded occurrence, each carrying its own target.
    expect(screen.getAllByTestId('problems-create-page')).toHaveLength(2);
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

  test('the create action is never counted by Auto-fix', () => {
    render(
      <ProblemsPanel docName="notes" diagnostics={[linkDiag({})]} onAutoFix={vi.fn(() => {})} />,
    );
    // A dead link is not deterministically fixable — the Auto-fix label counts 0.
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
    // Banked even though no source editor consumed the event (WYSIWYG case):
    // the next source-mode activation within the TTL replays it.
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
    // Mounting the panel in doc scope never runs the audit.
    expect(auditCalls).toBe(0);

    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(auditCalls).toBe(1);

    // Per-file groups render collapsed: headers with counts, contents unmounted.
    expect(screen.getByText('notes.md')).toBeTruthy();
    const groups = screen.getAllByTestId('problems-audit-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.getAttribute('data-state')).toBe('closed');
    expect(groups[0]?.querySelector('[data-testid="problems-audit-file-count"]')?.textContent).toBe(
      '2',
    );
    // A diagnostic message lives inside a collapsed group, so it is not mounted.
    expect(screen.queryByText('Heading increment')).toBeNull();
    // Expanding the group mounts its rows.
    expandGroup('guides/setup.md');
    expect(screen.getByText('Heading increment')).toBeTruthy();
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
    expandGroup('guides/setup.md');

    const tags = screen.getAllByTestId('problems-source-tag');
    expect(tags.map((tag) => tag.textContent)).toEqual(['markdownlint', 'links']);
    // The rollup summary carries the merged plane's counts.
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

    // The per-file badge counts problems (not collapsed rows) on the header,
    // before the group is opened.
    expect(screen.getByTestId('problems-audit-file-count').textContent).toBe('3');
    expandGroup('guides/setup.md');
    expect(screen.getAllByTestId('problems-duplicate-group')).toHaveLength(1);
    expect(screen.getAllByText('Missing title')).toHaveLength(1);
  });

  test('the refresh icon explains itself in a tooltip', async () => {
    runLintAuditImpl = async () => auditResult({ fileCount: 2 });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    // The tooltip only opens once the audit lands — the button is disabled
    // (and so not hoverable) while it runs.
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
      // The in-doc nav event stays quiet on cross-doc clicks. The banked,
      // document-scoped intent replays after the target editor activates.
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

      // Open the file group, then the collapsed duplicate group inside it, then
      // click the SECOND occurrence.
      expandGroup('guides/setup.md');
      fireEvent.click(
        screen.getByTestId('problems-duplicate-group').querySelector('button') as HTMLElement,
      );
      const occurrences = screen
        .getByTestId('problems-duplicate-instances')
        .querySelectorAll('button');
      expect(occurrences).toHaveLength(2);
      fireEvent.click(occurrences[1] as HTMLElement);

      // Cross-doc nav banks the intent by hash; the banked line is the clicked
      // occurrence (9), not the group's first (4) — the click carries its own
      // diagnostic through the project-scope onNavigate wrapper.
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
      // Cross-doc clicks stay off the in-doc event (it carries no docName).
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

    // Counts fixable problems across the audit (a.md + nested/c.md), not files
    // and not the unfixable b.md diagnostic.
    expect(screen.getByTestId('problems-auto-fix').textContent).toContain('(2)');
    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    // Only the two files carrying fixable diagnostics are swept, extension-less.
    await waitFor(() => expect(fixLintDocCalls).toEqual(['a', 'nested/c']));
    // The sweep ends in a fresh audit fetch (initial activation + re-audit).
    await waitFor(() => expect(auditCalls).toBe(2));
    // A sweep can finish with nobody watching the counter, so completion is
    // announced rather than inferred from the count landing on N/N.
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
    // Hold the first fix open so the sweep is genuinely mid-flight when Stop is
    // pressed — otherwise it could finish before the click and pass vacuously.
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
    // The Stop control exists only while a sweep is running.
    const stop = await screen.findByTestId('problems-cancel-fix');
    fireEvent.click(stop);
    releaseFirst?.();

    // The sweep bails at the next file boundary: 'a' was already in flight, so
    // it completes, but 'b' and 'c' are never posted.
    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(fixLintDocCalls).toEqual(['a']);
    expect(String(toastInfo.mock.calls[0]?.[0])).toContain('already fixed stay fixed');
    // A stop is not a failure — no error toast, and the spinner clears so the
    // panel is usable again rather than stuck mid-sweep.
    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('problems-cancel-fix')).toBeNull());
    // Re-audits after stopping so the remaining count is the honest one.
    await waitFor(() => expect(auditCalls).toBe(2));
  });

  test('a running sweep survives the panel unmounting and still reports how it ended', async () => {
    // The Problems tab is rendered conditionally, so switching to Timeline
    // unmounts this panel mid-sweep. That used to end the run silently, leaving
    // the project half-fixed with nothing to explain it on return.
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
    // Park the opening fix so the unmount lands while the sweep is genuinely
    // mid-flight, rather than after it has already finished.
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

    // Every file still gets fixed, and the completion toast reaches the user
    // through the app-root Toaster even though no panel is mounted.
    await waitFor(() => expect(fixLintDocCalls).toEqual(['a', 'b', 'c']));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
    // Nothing left to re-audit for: the panel that owned the plane is gone, so
    // the only walk was its initial activation.
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

    // The stop flag must reset, or the next sweep ends on its first boundary.
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
    // The failed file does not stop the sweep.
    await waitFor(() => expect(fixLintDocCalls).toEqual(['bad', 'good']));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(String(toastError.mock.calls[0]?.[0])).toContain('1 of 2');
    // The toast names the first casualty and the server's reason.
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
    // The server refuses once for agent-session capacity (503 + the capacity
    // URN), then accepts — the sweep must wait it out, not surface it as failed.
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
    // The same file is posted twice — the initial refusal and the retry that
    // succeeds — proving the component forwards the 503/URN into the retry path.
    await waitFor(() => expect(fixLintDocCalls).toEqual(['busy', 'busy']));
    // A retried-then-succeeded file is not a failure: no error toast.
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
    // Null detail → just the filename, no ` — ` suffix.
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
    // Loaded audit with zero fixable files keeps the button disabled.
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

    // The label still counts every problem across the audit, fixable or not —
    // that number is the panel's own, not something handed to the agent.
    expect(screen.getByTestId('problems-fix-with-ai').textContent).toContain('(3)');
    fireEvent.click(screen.getByTestId('problems-fix-with-ai'));
    expect(onFixWithAi.mock.calls).toEqual([['project']]);
  });

  test('project Fix all with AI stays hidden until the audit has something to describe', async () => {
    runLintAuditImpl = async () => auditResult({ files: [], fileCount: 3 });
    render(<ProblemsPanel docName="notes" diagnostics={[]} onFixWithAi={vi.fn(() => {})} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByTestId('problems-audit-summary')).toBeTruthy());
    // A clean project has no problems to hand over, so the button is absent
    // rather than an enabled no-op.
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
    // Zero problems means neither claim is true: nothing lacks a fix, and there
    // is no AI hand-off to point at.
    expect(tip.textContent).not.toMatch(/None of these problems/);
    expect(tip.textContent).not.toMatch(/Fix all with AI/);
    expect(button.getAttribute('aria-label')).not.toContain(
      'no problems here have an automatic fix',
    );
    // Pin the positive value too: the negative assertions above would also pass
    // on an empty or drifted label, so they cannot tell "correct" from "gone".
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

    // A finished sweep has to hand both affordances back, or the panel stays
    // permanently inert after one auto-fix. `waitFor` is load-bearing rather
    // than stylistic: the sweep closes with a re-audit, and during that reload
    // the AI button is absent (its handler is withheld until the audit loads).
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

  test('a lint-config change refreshes a LOADED project snapshot in place', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'notes.md', diagnostics: [diag({})] }] });
    render(<ProblemsPanel docName="other" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(auditCalls).toBe(1));

    // A rule toggle invalidates the snapshot's config: serving it on would show
    // problems for rules the project no longer has.
    emitLintConfigChangedForTest();
    await waitFor(() => expect(auditCalls).toBe(2));
  });

  test('a lint-config change does NOT audit while the panel sits in doc scope', async () => {
    runLintAuditImpl = async () => auditResult();
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);

    emitLintConfigChangedForTest();
    emitLintConfigChangedForTest();

    // Doc scope holds no project snapshot to invalidate, so a config change must
    // not provoke a whole-project walk here.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(auditCalls).toBe(0);
  });

  test('a lint-config change does not resurrect a snapshot the panel never loaded', async () => {
    runLintAuditImpl = async () => null;
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    // Enter project scope and let the audit FAIL, so status is 'failed'.
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(auditCalls).toBe(1));
    await waitFor(() => expect(screen.getByText(/could not be completed/i)).toBeTruthy());

    emitLintConfigChangedForTest();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A failed run keeps its error until the user retries — the refresh
    // affordance is the retry, not a config event.
    expect(auditCalls).toBe(1);
  });

  test('a superseded walk re-loads in place instead of surfacing an error', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'guides/setup.md', diagnostics: [diag({ line: 4 })] }] });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(auditCalls).toBe(1);

    // The server abandons a walk whose config moved under it. The same config
    // change drives the replacement, so the panel must neither render a failure
    // nor sit on a spinner no later event clears.
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

    // Refresh, and let the server abandon the walk. Nothing else is coming: the
    // `lint-config` push that would carry a replacement has no reconnect replay,
    // so the panel has to recover on its own or it sits on a spinner forever
    // with its only retry affordance disabled.
    runLintAuditImpl = async () => AUDIT_SUPERSEDED;
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
    await waitFor(() => expect(auditCalls).toBe(2));

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Re-run the project audit') as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    // The stale-but-real plane is still on screen, and no error was invented.
    expect(screen.getByText('guides/setup.md')).toBeTruthy();
    expect(screen.queryByText(/could not be completed/i)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    // And the recovered affordance actually works.
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'after-retry.md', diagnostics: [diag({})] }] });
    fireEvent.click(screen.getByLabelText('Re-run the project audit'));
    await waitFor(() => expect(screen.getByText('after-retry.md')).toBeTruthy());
  });

  test('a first activation that is superseded offers the retry rather than spinning', async () => {
    // Nothing has ever loaded, so there is no plane to fall back to — the panel
    // must still surface a reachable retry instead of an endless skeleton.
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

    // Refresh into a walk the server will abandon, held open so a config change
    // can start its replacement while it is still in flight.
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

    // The abandoned walk settles last. Its fallback is the plane from BEFORE the
    // replacement ran, so landing it would roll the panel back to stale truth.
    releaseSuperseded();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('second.md')).toBeTruthy();
    expect(screen.queryByText('first.md')).toBeNull();
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
    // Every group is closed, so no diagnostic rows are in the tree.
    for (const group of groups) expect(group.getAttribute('data-state')).toBe('closed');
    expect(screen.queryByText('Heading increment')).toBeNull();
    expect(screen.queryByTestId('problems-source-tag')).toBeNull();
    // Yet each header still shows the file path and its problem count.
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(groups[0]?.querySelector('[data-testid="problems-audit-file-count"]')?.textContent).toBe(
      '1',
    );
    // The reversal affordance is present and points at expanding.
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
    // The one control now offers the reverse action.
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
    // The other group's rows stay unmounted.
    expect(screen.queryByText('Hard tabs')).toBeNull();
    // One of two open still reads as "not all expanded".
    expect(screen.getByTestId('problems-audit-expand-toggle').getAttribute('aria-label')).toBe(
      'Expand all file groups',
    );
  });

  test('the expand/collapse-all control is absent when the audit is clean', async () => {
    runLintAuditImpl = async () => auditResult({ files: [], fileCount: 3 });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('No problems across 3 documents.')).toBeTruthy());
    // Nothing to expand, so the control does not render.
    expect(screen.queryByTestId('problems-audit-expand-toggle')).toBeNull();
  });
});

describe('ProblemsPanel — project scope: sweep-progress live region', () => {
  // A diagnostic carrying an auto-fix, so every file in these fixtures is swept.
  const fixableEdit = {
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
    newText: '  ',
  };

  test('a role=status region announces the running count while sweeping and retires when it ends', async () => {
    runLintAuditImpl = async () =>
      auditResult({ files: [{ file: 'solo.md', diagnostics: [diag({ fixes: [fixableEdit] })] }] });
    // Hold the one fix open so the sweep stays mid-flight to observe.
    let releaseFix: (() => void) | undefined;
    fixLintDocImpl = () =>
      new Promise<{ ok: true }>((resolve) => {
        releaseFix = () => resolve({ ok: true });
      });
    render(<ProblemsPanel docName="notes" diagnostics={[]} />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    await waitFor(() => expect(screen.getByText('solo.md')).toBeTruthy());

    // No sweep running: no sweep-progress region.
    expect(sweepLiveRegion()).toBeUndefined();

    fireEvent.click(screen.getByTestId('problems-auto-fix'));
    // While the sweep runs, a role=status live region announces the count.
    await waitFor(() => expect(sweepLiveRegion()?.textContent).toBe('Fixing 0 of 1 files'));
    expect(sweepLiveRegion()?.getAttribute('role')).toBe('status');

    releaseFix?.();
    // The region is gone once the sweep ends; the re-audit's own status skeleton
    // carries no "Fixing" text, so it is not mistaken for the sweep region.
    await waitFor(() => expect(sweepLiveRegion()).toBeUndefined());
  });

  test('the announced count advances as the sweep progresses', async () => {
    // A chunk-plus-one sweep publishes several interior flushes (one every
    // sweepProgressInterval files) climbing toward the total; hold the last file
    // so the final interior flush is a stable state to assert on rather than a
    // single frame before the region retires.
    const total = SWEEP_PROGRESS_CHUNK + 1;
    const interval = sweepProgressInterval(total);
    // The last flush before the parked final file lands on the highest interval
    // multiple among the files that actually complete (all but the parked last).
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
    // Opens at zero, then climbs to the last interior flush once that many complete.
    await waitFor(() => expect(sweepLiveRegion()?.textContent).toBe(`Fixing 0 of ${total} files`));
    await waitFor(
      () =>
        expect(sweepLiveRegion()?.textContent).toBe(
          `Fixing ${lastInteriorFlush} of ${total} files`,
        ),
      { timeout: 10_000 },
    );

    // The last file is requested (and parked) just after that flush; wait for it
    // so releasing it actually completes the sweep rather than no-ops.
    await waitFor(() => expect(fixLintDocCalls.length).toBe(total));
    releaseLast?.();
    await waitFor(() => expect(sweepLiveRegion()).toBeUndefined());
  });

  test('the region announces at chunk granularity, not once per file', async () => {
    // With the sub-chunk floor the interval here is two files, so completing an
    // odd (non-boundary) file must NOT move the count — a per-file announcer
    // would — while crossing the next interval boundary must.
    const total = 11;
    expect(sweepProgressInterval(total)).toBe(2);
    runLintAuditImpl = async () =>
      auditResult({
        files: Array.from({ length: total }, (_, i) => ({
          file: `f${i}.md`,
          diagnostics: [diag({ fixes: [fixableEdit] })],
        })),
      });
    // Park the first three fixes so the sweep steps under the test's control
    // across a non-boundary file (held) then an interval boundary (advances);
    // the rest resolve at once so the sweep can finish.
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

    // Complete file 1, a non-boundary file. A per-file announcer would read
    // "1 of 11" here — chunked, the count holds at zero until the flush.
    parked[0]?.();
    await waitFor(() => expect(fixLintDocCalls.length).toBe(2));
    expect(sweepLiveRegion()?.textContent).toBe(`Fixing 0 of ${total} files`);

    // Complete file 2, crossing the interval boundary; now the count advances.
    parked[1]?.();
    await waitFor(() => expect(sweepLiveRegion()?.textContent).toBe(`Fixing 2 of ${total} files`));

    // Release the rest: wait for file 3 to be requested (and parked) so its
    // resolver exists, then release it — the remaining files resolve at once and
    // the region retires when the sweep finishes.
    await waitFor(() => expect(fixLintDocCalls.length).toBe(3));
    parked[2]?.();
    await waitFor(() => expect(sweepLiveRegion()).toBeUndefined());
  });
});
