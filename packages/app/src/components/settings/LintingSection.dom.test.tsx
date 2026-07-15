/**
 * RTL mount tests for the linter Settings sections (the lint-plugin model).
 * Behavior is driven through a mocked project ConfigContext binding and asserted
 * on the exact CRDT patch payloads (per-plugin toggle) and on the native-rule
 * editor's write calls + gated visibility of controls.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Config, ConfigBinding } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

let mockProjectConfig: Config | null = null;
let mockProjectSynced = true;
let mockProjectBinding: ConfigBinding | null = null;

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    projectBinding: mockProjectBinding,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: mockProjectConfig,
    projectSynced: mockProjectSynced,
    projectLocalConfig: null,
    projectLocalSynced: false,
    merged: null,
  }),
}));

// The markdownlint editor reads native rules via `useProjectLintConfig()` and
// writes via `writeMarkdownlintRule`. Mock the lint-config client so the panel's
// data is controllable and writes are observable. The other exports keep their
// benign jsdom behavior (fetches fail → null), matching the unmocked module.
let mockProjectLintData: unknown = null;
const writeMarkdownlintRuleCalls: Array<[string, unknown]> = [];
function projectDataWithMarkdownlintRules(
  rules: Record<string, unknown>,
  configFile?: string,
): unknown {
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
mock.module('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {},
  subscribeToLintConfigChanged: () => () => {},
  runLintAudit: async () => null,
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: mockProjectLintData }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async (ruleId: string, value: unknown) => {
    writeMarkdownlintRuleCalls.push([ruleId, value]);
    // Match the production discriminated union so tests exercise the success
    // branch (a bare LintConfigResponse would read as ok: undefined → error path).
    return { ok: true, response: mockProjectLintData };
  },
}));

const { ProjectPluginsManageSection, UserPluginsManageSection, MarkdownlintPluginSection } =
  await import('./LintingSection');

interface SliceOverrides {
  markdownlint?: Record<string, unknown>;
}

function configWith(linter: SliceOverrides): Config {
  return {
    contentRules: {
      markdownlint: { enabled: true, ...linter.markdownlint },
    },
  } as unknown as Config;
}

function makeBinding(): { binding: ConfigBinding; calls: unknown[] } {
  const calls: unknown[] = [];
  const binding = {
    current: () => ({}),
    patch: (patch: unknown) => {
      calls.push(patch);
      return { ok: true, value: { applied: [], effective: {} } };
    },
    subscribe: () => () => {},
  } as unknown as ConfigBinding;
  return { binding, calls };
}

beforeEach(() => {
  mockProjectConfig = configWith({});
  mockProjectSynced = true;
  mockProjectBinding = null;
  mockProjectLintData = null;
  writeMarkdownlintRuleCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('ProjectPluginsManageSection', () => {
  test('renders the project plugin toggles and points project audits at the Problems panel', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);
    expect(screen.getByTestId('settings-plugin-toggle-markdownlint')).toBeDefined();
    // The user-scope theme toggle is NOT here — it lives in the User → Plugins page.
    expect(screen.queryByTestId('settings-plugin-toggle-theme')).toBeNull();
    // The project audit lives in the Problems panel, not Settings — no runner here.
    expect(screen.queryByTestId('settings-linting-audit')).toBeNull();
    expect(screen.getByTestId('settings-plugins-audit-pointer').textContent).toContain(
      'Run a project audit from the Problems panel',
    );
  });

  test('toggling a project plugin writes the per-plugin enabled patch', async () => {
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);
    await userEvent.click(screen.getByTestId('settings-plugin-toggle-markdownlint'));
    expect(calls).toContainEqual({
      contentRules: { markdownlint: { enabled: false } },
    });
  });

  test('disables controls until the binding is ready', () => {
    mockProjectBinding = null;
    mockProjectSynced = false;
    render(<ProjectPluginsManageSection />);
    expect(
      (screen.getByTestId('settings-plugin-toggle-markdownlint') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('UserPluginsManageSection', () => {
  test('renders only the user-scope Themes toggle, not project plugins', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<UserPluginsManageSection userBinding={null} />);
    expect(screen.getByTestId('settings-plugin-toggle-theme')).toBeDefined();
    expect(screen.queryByTestId('settings-plugin-toggle-markdownlint')).toBeNull();
  });

  test('the Themes toggle writes the user-scope enabled patch', async () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    // The theme plugin is user-scope, so it writes through the user binding.
    const { binding: userBinding, calls: userCalls } = makeBinding();
    render(<UserPluginsManageSection userBinding={userBinding} />);
    await userEvent.click(screen.getByTestId('settings-plugin-toggle-theme'));
    expect(userCalls).toContainEqual({ appearance: { colorThemeEnabled: false } });
  });
});

// Row-level browser behavior (search, filters, toggles, MD043 editor, severity
// chips) is covered in markdownlint-rule-browser.dom.test.tsx; this block pins
// the section wrapper: header + browser mount + the config-source description.
describe('MarkdownlintPluginSection', () => {
  test('renders the full-catalog rule browser', () => {
    mockProjectLintData = projectDataWithMarkdownlintRules({ default: true });
    render(
      <TooltipProvider>
        <MarkdownlintPluginSection />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('settings-plugin-markdownlint')).toBeDefined();
    expect(screen.getByTestId('settings-linting-markdownlint-rules')).toBeDefined();
    expect(screen.getByTestId('markdownlint-rule-search')).toBeDefined();
    expect(screen.getByTestId('markdownlint-rule-row-MD001')).toBeDefined();
  });

  test('names the project config file in the description when one is present', () => {
    // When the project has a committed `.markdownlint.*`, the description
    // switches to a different UX context — it names the file and says it
    // governs linting — and interpolates the filename via <Trans>.
    mockProjectLintData = projectDataWithMarkdownlintRules({ MD010: false }, '.markdownlint.json');
    render(
      <TooltipProvider>
        <MarkdownlintPluginSection />
      </TooltipProvider>,
    );
    const rules = screen.getByTestId('settings-linting-markdownlint-rules');
    expect(rules.textContent).toContain('.markdownlint.json');
    expect(rules.textContent).toContain('governs linting');
  });
});
