/**
 * RTL mount tests for the full-catalog markdownlint rule browser: every
 * generated-catalog rule renders grouped by display category; row state
 * derives from the resolved governing config (alias-aware, case-insensitive,
 * last-matching-key-wins entry, else `default`, else on — the engine's own
 * resolution order); search and the only-modified filter narrow the list
 * client-side; toggles,
 * resets, and expanded-row option edits write through the lint-config client.
 */

import {
  DEFAULT_MARKDOWNLINT_CONFIG,
  MARKDOWNLINT_RULE_CATALOG,
} from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

// Radix primitives reach for DOM globals the jsdom preload doesn't expose;
// hoist the same shims the sibling settings DOM tests use.
type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

let mockProjectLintData: unknown = null;
const writeCalls: Array<[string, unknown]> = [];
// Default write outcome; a test overrides this to exercise the failure toast.
let mockWriteResult: { ok: boolean; errorDetail?: string; response?: unknown } | null = null;
const toastErrors: string[] = [];

function lintData(rules: Record<string, unknown>, configFile?: string): unknown {
  return {
    ...(configFile ? { configFile } : {}),
    effective: {
      enabled: true,
      plugins: {
        markdownlint: { enabled: true, rules },
      },
    },
  };
}

vi.doMock('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {},
  subscribeToLintConfigChanged: () => () => {},
  runLintAudit: async () => null,
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: mockProjectLintData }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async (ruleId: string, value: unknown) => {
    writeCalls.push([ruleId, value]);
    return mockWriteResult ?? { ok: true, response: mockProjectLintData };
  },
}));

vi.doMock('sonner', () => ({
  toast: {
    error: (msg: string) => {
      toastErrors.push(msg);
    },
    success: () => {},
  },
}));

const { MarkdownlintRuleBrowser } = await import('./markdownlint-rule-browser');

function renderBrowser(props?: { hideConfigSourceNote?: boolean }) {
  return render(
    <TooltipProvider>
      <MarkdownlintRuleBrowser {...props} />
    </TooltipProvider>,
  );
}

function ruleRows(): HTMLElement[] {
  return screen.queryAllByTestId(/^markdownlint-rule-row-/);
}

beforeEach(() => {
  mockProjectLintData = lintData({ ...DEFAULT_MARKDOWNLINT_CONFIG });
  writeCalls.length = 0;
  mockWriteResult = null;
  toastErrors.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('MarkdownlintRuleBrowser — no-file disclaimer', () => {
  test('shows the create-file disclaimer only when no config file governs', () => {
    // Default mock has no configFile → no-file state.
    renderBrowser();
    expect(screen.getByTestId('markdownlint-no-file-disclaimer')).toBeDefined();
    cleanup();

    mockProjectLintData = lintData({ default: true }, '.markdownlint.json');
    renderBrowser();
    expect(screen.queryByTestId('markdownlint-no-file-disclaimer')).toBeNull();
  });
});

describe('MarkdownlintRuleBrowser — config source note', () => {
  test('shows the source note by default but hides it when hideConfigSourceNote is set', () => {
    mockProjectLintData = lintData({ default: true }, '.markdownlint.json');

    renderBrowser();
    expect(screen.getByTestId('markdownlint-config-source-note')).toBeDefined();
    cleanup();

    // The lint-config editor mounts with the note suppressed — the user is
    // already looking at the file, so the "these rules come from <file>" note
    // is redundant. The Modified-badge legend stays.
    renderBrowser({ hideConfigSourceNote: true });
    expect(screen.queryByTestId('markdownlint-config-source-note')).toBeNull();
    expect(screen.getByTestId('markdownlint-rule-browser-legend')).toBeDefined();
  });
});

describe('MarkdownlintRuleBrowser — full-catalog listing', () => {
  test('renders every generated-catalog rule grouped into category sections', () => {
    renderBrowser();
    expect(ruleRows().length).toBe(MARKDOWNLINT_RULE_CATALOG.length);
    for (const slug of ['headings', 'lists', 'whitespace', 'code', 'links-images', 'style']) {
      expect(screen.getByTestId(`markdownlint-rule-category-${slug}`)).toBeDefined();
    }
  });

  test('row state follows rules[id] ?? default ?? true; tuned defaults are not Modified', () => {
    renderBrowser();
    // MD013 is in OK's tuned disable list; MD001 falls back to `default: true`.
    expect(screen.getByTestId('markdownlint-rule-toggle-MD013').getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByTestId('markdownlint-rule-toggle-MD001').getAttribute('aria-checked')).toBe(
      'true',
    );
    // No governing file → the resolved keys are OK defaults, not user overrides.
    expect(screen.queryAllByTestId(/^markdownlint-rule-modified-/).length).toBe(0);
  });

  test('a config default:false turns non-overridden rows off', () => {
    mockProjectLintData = lintData({ default: false, MD010: true }, '.markdownlint.json');
    renderBrowser();
    expect(screen.getByTestId('markdownlint-rule-toggle-MD001').getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByTestId('markdownlint-rule-toggle-MD010').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  test('keys set by the governing file render the Modified badge', () => {
    mockProjectLintData = lintData({ default: true, MD001: false }, '.markdownlint.json');
    renderBrowser();
    expect(screen.getByTestId('markdownlint-rule-modified-MD001')).toBeDefined();
    expect(screen.queryByTestId('markdownlint-rule-modified-MD003')).toBeNull();
  });
});

describe('MarkdownlintRuleBrowser — alias-keyed config entries', () => {
  test('an alias-keyed entry governs its rule row and reads as Modified', () => {
    mockProjectLintData = lintData({ default: true, 'line-length': false }, '.markdownlint.json');
    renderBrowser();
    expect(screen.getByTestId('markdownlint-rule-toggle-MD013').getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByTestId('markdownlint-rule-modified-MD013')).toBeDefined();
  });

  test('config keys match case-insensitively, like the engine', () => {
    mockProjectLintData = lintData({ default: true, 'LINE-LENGTH': false }, '.markdownlint.json');
    renderBrowser();
    expect(screen.getByTestId('markdownlint-rule-toggle-MD013').getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByTestId('markdownlint-rule-modified-MD013')).toBeDefined();
  });

  test('when id and alias both address a rule, the last key wins', () => {
    mockProjectLintData = lintData(
      { default: true, MD013: false, 'line-length': true },
      '.markdownlint.json',
    );
    renderBrowser();
    expect(screen.getByTestId('markdownlint-rule-toggle-MD013').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('markdownlint-rule-modified-MD013')).toBeDefined();
  });

  test('the only-modified filter includes alias-keyed rules', async () => {
    mockProjectLintData = lintData({ default: true, 'line-length': false }, '.markdownlint.json');
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-only-modified'));
    expect(ruleRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'markdownlint-rule-row-MD013',
    ]);
  });
});

describe('MarkdownlintRuleBrowser — search and only-modified', () => {
  test('search narrows by id, alias, and name; empty sections disappear', async () => {
    renderBrowser();
    const search = screen.getByTestId('markdownlint-rule-search');

    await userEvent.type(search, 'single-title');
    expect(ruleRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'markdownlint-rule-row-MD025',
    ]);
    // MD025 is a Headings rule — the other category sections are gone.
    expect(screen.queryByTestId('markdownlint-rule-category-style')).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, 'md013');
    expect(screen.getByTestId('markdownlint-rule-row-MD013')).toBeDefined();
    expect(screen.queryByTestId('markdownlint-rule-row-MD025')).toBeNull();
  });

  test('a query matching nothing shows the filtered empty state', async () => {
    renderBrowser();
    await userEvent.type(screen.getByTestId('markdownlint-rule-search'), 'zzz-no-such-rule');
    expect(ruleRows().length).toBe(0);
    expect(screen.getByTestId('markdownlint-rule-browser-empty')).toBeDefined();
  });

  test('only-modified shows exactly the file-set rules, never meta-keys', async () => {
    mockProjectLintData = lintData(
      { default: true, MD001: false, MD010: 'error' },
      '.markdownlint.json',
    );
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-only-modified'));
    expect(
      ruleRows()
        .map((row) => row.getAttribute('data-testid'))
        .sort(),
    ).toEqual(['markdownlint-rule-row-MD001', 'markdownlint-rule-row-MD010']);
  });

  test('only-modified with no governing file shows the empty state', async () => {
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-only-modified'));
    expect(ruleRows().length).toBe(0);
    expect(screen.getByTestId('markdownlint-rule-browser-empty')).toBeDefined();
  });
});

describe('MarkdownlintRuleBrowser — writes', () => {
  test('toggling a default-on rule absent from the file writes a bare boolean off', async () => {
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-rule-toggle-MD001'));
    expect(writeCalls).toContainEqual(['MD001', false]);
  });

  test('toggling preserves an option-carrying value via enabled:false', async () => {
    mockProjectLintData = lintData(
      { default: true, MD013: { line_length: 100 } },
      '.markdownlint.json',
    );
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-rule-toggle-MD013'));
    expect(writeCalls).toContainEqual(['MD013', { line_length: 100, enabled: false }]);
  });

  test('reset clears a modified rule back to the default', async () => {
    mockProjectLintData = lintData({ default: true, MD001: false }, '.markdownlint.json');
    renderBrowser();
    await userEvent.click(screen.getByLabelText('Reset MD001 to default'));
    expect(writeCalls).toContainEqual(['MD001', null]);
  });

  test('a declined write surfaces the server detail as an error toast', async () => {
    mockWriteResult = {
      ok: false,
      errorDetail: 'The native markdownlint config (.markdownlint.cjs) cannot be rewritten',
    };
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-rule-toggle-MD001'));
    expect(toastErrors).toContainEqual(
      'The native markdownlint config (.markdownlint.cjs) cannot be rewritten',
    );
  });

  // Regression: the toggle must keep its own `data-state`, not inherit the
  // wrapping tooltip's open/closed state. When the tooltip trigger clobbers it,
  // `data-checked:bg-primary` stops matching and an on rule renders invisibly.
  test('an on rule keeps data-state=checked (tooltip does not clobber the switch)', () => {
    renderBrowser();
    const onToggle = screen.getByTestId('markdownlint-rule-toggle-MD001');
    expect(onToggle.getAttribute('data-state')).toBe('checked');
  });

  test('an off rule keeps data-state=unchecked', () => {
    mockProjectLintData = lintData({ default: true, MD001: false }, '.markdownlint.json');
    renderBrowser();
    const offToggle = screen.getByTestId('markdownlint-rule-toggle-MD001');
    expect(offToggle.getAttribute('data-state')).toBe('unchecked');
  });
});

describe('MarkdownlintRuleBrowser — expanded-row option editing', () => {
  test('expanding a row reveals the doc link and typed option fields with effective values', async () => {
    mockProjectLintData = lintData(
      { default: true, MD013: { line_length: 120 } },
      '.markdownlint.json',
    );
    renderBrowser();
    // Collapsed rows keep their option editors out of the DOM.
    expect(screen.queryByLabelText('line_length')).toBeNull();

    await userEvent.click(screen.getByTestId('markdownlint-rule-expand-MD013'));
    const md013 = MARKDOWNLINT_RULE_CATALOG.find((rule) => rule.id === 'MD013');
    if (md013 === undefined) throw new Error('MD013 missing from the generated catalog');
    const docLink = screen.getByRole('link', {
      name: 'Documentation for MD013 (opens in browser)',
    });
    expect(docLink.getAttribute('href')).toBe(md013.docUrl);
    // The file's value backs the field; unset options fall back to defaults.
    expect((screen.getByLabelText('line_length') as HTMLInputElement).value).toBe('120');
    expect(screen.getByLabelText('code_blocks').getAttribute('aria-checked')).toBe('true');
  });

  test('the MDxxx · alias identifier lives in the expanded detail, not the collapsed row', async () => {
    mockProjectLintData = lintData({ default: true }, '.markdownlint.json');
    renderBrowser();
    // Collapsed: the row shows only the rule name; the identifier is hidden to
    // keep the row uncrowded (CollapsibleContent is unmounted while closed).
    expect(screen.queryByText('MD013 · line-length')).toBeNull();

    await userEvent.click(screen.getByTestId('markdownlint-rule-expand-MD013'));
    // Expanded: the id · alias appears in the detail alongside the doc link.
    expect(screen.getByText('MD013 · line-length')).toBeDefined();
  });

  test('editing one option writes the composed full value, preserving sibling keys', async () => {
    mockProjectLintData = lintData(
      { default: true, MD013: { line_length: 120, code_blocks: false, unknown_key: 'x' } },
      '.markdownlint.json',
    );
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-rule-expand-MD013'));
    const field = screen.getByLabelText('line_length') as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, '100');
    await userEvent.tab();
    expect(writeCalls).toContainEqual([
      'MD013',
      { line_length: 100, code_blocks: false, unknown_key: 'x' },
    ]);
  });

  test('MD043 headings are editable through the generic string-array field', async () => {
    mockProjectLintData = lintData(
      { default: true, MD043: { headings: ['## Summary'] } },
      '.markdownlint.json',
    );
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-rule-expand-MD043'));
    const input = screen.getByLabelText('headings') as HTMLInputElement;
    await userEvent.type(input, '## Details{enter}');
    expect(writeCalls).toContainEqual(['MD043', { headings: ['## Summary', '## Details'] }]);
  });

  test('a rule with no options still expands to its doc link', async () => {
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-rule-expand-MD045'));
    expect(
      screen.getByRole('link', { name: 'Documentation for MD045 (opens in browser)' }),
    ).toBeDefined();
    expect(screen.queryAllByTestId(/^rule-option-MD045-/).length).toBe(0);
  });
});

describe('MarkdownlintRuleBrowser — severity strings and disclosure', () => {
  test('a severity-string value renders enabled + Modified with a read-only chip', () => {
    mockProjectLintData = lintData({ default: true, MD010: 'error' }, '.markdownlint.json');
    renderBrowser();
    const row = screen.getByTestId('markdownlint-rule-row-MD010');
    expect(
      within(row).getByTestId('markdownlint-rule-toggle-MD010').getAttribute('aria-checked'),
    ).toBe('true');
    expect(within(row).getByTestId('markdownlint-rule-severity-MD010').textContent).toBe('error');
    expect(within(row).getByTestId('markdownlint-rule-modified-MD010')).toBeDefined();
    // No chip on rows without a severity-string value.
    expect(screen.queryByTestId('markdownlint-rule-severity-MD001')).toBeNull();
  });

  test('toggling a severity-string rule replaces it with a bare boolean', async () => {
    mockProjectLintData = lintData({ default: true, MD010: 'warning' }, '.markdownlint.json');
    renderBrowser();
    await userEvent.click(screen.getByTestId('markdownlint-rule-toggle-MD010'));
    expect(writeCalls).toContainEqual(['MD010', false]);
  });

  test('the toggle carries an accessible label and shows no hover tooltip', async () => {
    mockProjectLintData = lintData({ default: true, MD010: 'error' }, '.markdownlint.json');
    renderBrowser();
    const toggle = screen.getByTestId('markdownlint-rule-toggle-MD010');
    // The on/off control names itself via aria-label — it lost the visible Label
    // when the rule name became the disclosure trigger.
    expect(toggle.getAttribute('aria-label')).toBeTruthy();
    // The old "Edits replace this rule's entire value…" tooltip was removed.
    await userEvent.hover(toggle);
    await Promise.resolve();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
