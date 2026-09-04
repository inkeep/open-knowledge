import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

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

const VIEW_MODE_KEY = 'ok-lint-config-view-mode-v1';
const ROOT_CONFIG = '.markdownlint.json';
const NESTED_CONFIG = 'docs/.markdownlint.json';

let mockProjectLintData: { configFile: string | null } | null = null;

vi.doMock('@/editor/lint-config-client', () => ({
  useProjectLintConfig: () => ({ data: mockProjectLintData }),
}));

vi.doMock('@/components/TextViewer', () => ({
  TextViewer: (props: { src?: string; fileName: string; extension: string }) => (
    <div
      data-testid="mock-text-viewer"
      data-src={props.src}
      data-filename={props.fileName}
      data-extension={props.extension}
    />
  ),
}));

vi.doMock('@/components/settings/markdownlint-rule-browser', () => ({
  MarkdownlintRuleBrowser: () => <div data-testid="mock-rule-browser" />,
}));

vi.doMock('@/components/NotInSidebarIndicator', () => ({
  NotInSidebarIndicator: (props: { entry: unknown }) => (
    <div data-testid="mock-not-in-sidebar" data-entry={JSON.stringify(props.entry)} />
  ),
}));

const { LintConfigEditor } = await import('./LintConfigEditor');

function renderEditor(assetPath: string) {
  return render(
    <TooltipProvider>
      <LintConfigEditor assetPath={assetPath} />
    </TooltipProvider>,
  );
}

function rulesSegment(): HTMLButtonElement {
  return screen.getByLabelText('Rules') as HTMLButtonElement;
}
function sourceSegment(): HTMLButtonElement {
  return screen.getByLabelText('Source') as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.clear();
  mockProjectLintData = { configFile: ROOT_CONFIG };
});

afterEach(() => {
  cleanup();
});

describe('LintConfigEditor — toggle and default view', () => {
  test('renders a Source/Rules toggle and defaults to the Source view', () => {
    renderEditor(ROOT_CONFIG);

    expect(rulesSegment()).toBeDefined();
    expect(sourceSegment()).toBeDefined();

    const viewer = screen.getByTestId('mock-text-viewer');
    expect(viewer.getAttribute('data-src')).toBe(
      `/api/asset-text?path=${encodeURIComponent(ROOT_CONFIG)}`,
    );
    expect(viewer.getAttribute('data-extension')).toBe('json');
    expect(screen.queryByTestId('mock-rule-browser')).toBeNull();

    expect(screen.getByTestId('mock-not-in-sidebar').getAttribute('data-entry')).toBe(
      JSON.stringify({ kind: 'asset', path: ROOT_CONFIG }),
    );
  });

  test('renders JSON-highlighted source directly for a .jsonc config', () => {
    const jsoncPath = '.markdownlint.jsonc';
    mockProjectLintData = { configFile: jsoncPath };
    renderEditor(jsoncPath);

    expect(screen.getByTestId('mock-text-viewer').getAttribute('data-extension')).toBe('jsonc');
  });
});

describe('LintConfigEditor — correct-target gating', () => {
  test('enables Rules for the governing root config', () => {
    renderEditor(ROOT_CONFIG);
    expect(rulesSegment().disabled).toBe(false);
  });

  test('disables Rules for a non-governing nested config, Source still works', () => {
    mockProjectLintData = { configFile: ROOT_CONFIG };
    renderEditor(NESTED_CONFIG);

    expect(rulesSegment().disabled).toBe(true);
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
  });

  test('disables Rules when no native config file governs, Source still works', () => {
    mockProjectLintData = { configFile: null };
    renderEditor(ROOT_CONFIG);

    expect(rulesSegment().disabled).toBe(true);
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
  });

  test('the disabled Rules segment explains why via a tooltip', async () => {
    const user = userEvent.setup();
    mockProjectLintData = { configFile: null };
    renderEditor(ROOT_CONFIG);

    const trigger = rulesSegment().parentElement;
    if (trigger === null) throw new Error('expected the Rules segment to have a wrapping trigger');
    await user.hover(trigger);
    await Promise.resolve();

    expect(screen.getByRole('tooltip').textContent).toBe(
      "Rule editing is available for the project's root markdownlint config",
    );
  });

  test('the disabled Rules reason is exposed via aria-describedby (not the poorly-supported aria-description)', () => {
    mockProjectLintData = { configFile: null };
    renderEditor(ROOT_CONFIG);

    const rules = rulesSegment();
    const describedById = rules.getAttribute('aria-describedby');
    expect(describedById).not.toBeNull();
    expect(document.getElementById(describedById as string)?.textContent).toBe(
      "Rule editing is available for the project's root markdownlint config",
    );
    expect(rules.getAttribute('aria-description')).toBeNull();
  });

  test('the enabled Rules segment names itself via its tooltip', async () => {
    const user = userEvent.setup();
    renderEditor(ROOT_CONFIG);

    const trigger = rulesSegment().parentElement;
    if (trigger === null) throw new Error('expected the Rules segment to have a wrapping trigger');
    await user.hover(trigger);
    await Promise.resolve();

    expect(screen.getByRole('tooltip').textContent).toBe('Rules');
  });

  test('the Source segment names itself via its tooltip (the sourceLabel override)', async () => {
    const user = userEvent.setup();
    renderEditor(ROOT_CONFIG);

    const trigger = sourceSegment().parentElement;
    if (trigger === null) throw new Error('expected the Source segment to have a wrapping trigger');
    await user.hover(trigger);
    await Promise.resolve();

    expect(screen.getByRole('tooltip').textContent).toBe('Source');
  });
});

describe('LintConfigEditor — switching and persistence', () => {
  test('switching to Rules mounts the rule browser, unmounts Source, and persists', async () => {
    const user = userEvent.setup();
    renderEditor(ROOT_CONFIG);

    await user.click(rulesSegment());
    expect(screen.getByTestId('mock-rule-browser')).toBeDefined();
    expect(screen.queryByTestId('mock-text-viewer')).toBeNull();
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('rules');

    await user.click(sourceSegment());
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
    expect(screen.queryByTestId('mock-rule-browser')).toBeNull();
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('source');
  });

  test('a persisted Rules preference reopens in Rules on a governing config', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'rules');
    renderEditor(ROOT_CONFIG);

    expect(screen.getByTestId('mock-rule-browser')).toBeDefined();
    expect(screen.queryByTestId('mock-text-viewer')).toBeNull();
  });

  test('a persisted Rules preference falls back to Source on a non-governing config', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'rules');
    mockProjectLintData = { configFile: ROOT_CONFIG };
    renderEditor(NESTED_CONFIG);

    expect(rulesSegment().disabled).toBe(true);
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
    expect(screen.queryByTestId('mock-rule-browser')).toBeNull();
  });
});
