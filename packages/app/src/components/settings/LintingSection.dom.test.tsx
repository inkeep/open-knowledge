/**
 * RTL mount tests for the linter Settings sections (the lint-plugin model).
 * Behavior is driven through a mocked project ConfigContext binding and asserted
 * on the exact CRDT patch payloads (per-plugin toggle) and on the native-rule
 * editor's write calls + gated visibility of controls.
 */

import type { Config, ConfigBinding } from '@inkeep/open-knowledge-core';
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

let mockProjectConfig: Config | null = null;
let mockUserConfig: Config | null = null;
let mockProjectSynced = true;
let mockProjectBinding: ConfigBinding | null = null;

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    projectBinding: mockProjectBinding,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: mockUserConfig,
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
vi.doMock('@/editor/lint-config-client', () => ({
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

// The enable notice is a toast; capture it instead of rendering a Toaster so the
// action's deep-link target is assertable without sonner's portal + timers.
interface ToastOptions {
  id?: string;
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}
interface CapturedToast extends ToastOptions {
  message: string;
}
const successToasts: CapturedToast[] = [];
vi.doMock('sonner', () => ({
  toast: {
    success: (message: string, options?: ToastOptions) => {
      successToasts.push({ message, ...options });
    },
    error: () => {},
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

function makeBinding(options: { ok?: boolean } = {}): {
  binding: ConfigBinding;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const ok = options.ok !== false;
  const binding = {
    current: () => ({}),
    patch: (patch: unknown) => {
      calls.push(patch);
      return ok
        ? { ok: true, value: { applied: [], effective: {} } }
        : { ok: false, error: { code: 'invalid' } };
    },
    subscribe: () => () => {},
  } as unknown as ConfigBinding;
  return { binding, calls };
}

/** A config where every project plugin reads as OFF, so a click ENABLES it. */
function configWithNoPluginsEnabled(): Config {
  return { contentRules: {} } as unknown as Config;
}

beforeEach(() => {
  mockProjectConfig = configWith({});
  mockUserConfig = null;
  mockProjectSynced = true;
  mockProjectBinding = null;
  mockProjectLintData = null;
  writeMarkdownlintRuleCalls.length = 0;
  successToasts.length = 0;
  window.location.hash = '';
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
    // The frontmatter plugin is feature-beta; markdownlint is not.
    const list = screen.getByTestId('settings-plugins-list');
    const rows = within(list).getAllByText('Beta');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closest('label')?.textContent).toContain('Frontmatter schemas');
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

  test('enabling a plugin offers its settings panel, and the offer deep-links there', async () => {
    // The gap this closes: enabling happens here, but the plugin is configured
    // on its own page — which can sit scrolled off screen in the sidebar.
    mockProjectConfig = configWithNoPluginsEnabled();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);

    await userEvent.click(screen.getByTestId('settings-plugin-toggle-frontmatter'));

    expect(successToasts).toHaveLength(1);
    expect(successToasts[0]?.message).toBe('Frontmatter schemas enabled');
    successToasts[0]?.action?.onClick();
    expect(window.location.hash).toBe('#settings/plugin:frontmatter');
  });

  test('the notice carries a per-plugin id so repeat toggles replace rather than stack', async () => {
    // The fixed id is the whole mechanism behind "toggling the same plugin
    // repeatedly replaces the notice"; without this assertion that claim is
    // just a docstring. Duration and description are the other two options the
    // notice depends on and nothing else pinned.
    mockProjectConfig = configWithNoPluginsEnabled();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);

    await userEvent.click(screen.getByTestId('settings-plugin-toggle-frontmatter'));
    await userEvent.click(screen.getByTestId('settings-plugin-toggle-markdownlint'));

    expect(successToasts.map((toast) => toast.id)).toEqual([
      'plugin-enabled-frontmatter',
      'plugin-enabled-markdownlint',
    ]);
    expect(successToasts[0]?.description).toBe('Set it up on its own page under Plugins.');
    expect(successToasts[0]?.duration).toBe(8000);
  });

  test('disabling a plugin says nothing (nothing new to configure)', async () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    // configWith({}) leaves markdownlint enabled, so this click turns it OFF.
    render(<ProjectPluginsManageSection />);
    await userEvent.click(screen.getByTestId('settings-plugin-toggle-markdownlint'));
    expect(successToasts).toHaveLength(0);
  });

  test('a rejected write does not claim the plugin was enabled', async () => {
    mockProjectConfig = configWithNoPluginsEnabled();
    const { binding } = makeBinding({ ok: false });
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);
    await userEvent.click(screen.getByTestId('settings-plugin-toggle-frontmatter'));
    expect(successToasts).toHaveLength(0);
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
    // Turning it OFF is not an invitation to go configure it.
    expect(successToasts).toHaveLength(0);
  });

  test('re-enabling Themes offers its panel too (the user-scope plugin is not special-cased)', async () => {
    const { binding: userBinding } = makeBinding();
    // Absent-or-false is the only way `colorThemeEnabled` reads as off; the
    // default is on, so start from an explicit false.
    mockUserConfig = { appearance: { colorThemeEnabled: false } } as unknown as Config;
    render(<UserPluginsManageSection userBinding={userBinding} />);

    await userEvent.click(screen.getByTestId('settings-plugin-toggle-theme'));

    expect(successToasts).toHaveLength(1);
    expect(successToasts[0]?.message).toBe('Themes enabled');
    successToasts[0]?.action?.onClick();
    expect(window.location.hash).toBe('#settings/plugin:theme');
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
    // markdownlint is a project-scope plugin — the header carries a Project badge.
    expect(screen.getByTestId('settings-scope-badge-project')).toBeDefined();
    expect(screen.queryByTestId('settings-scope-badge-user')).toBeNull();
  });

  test('links its docs page from the panel header', () => {
    // The standing counterpart to the enable toast — whoever lands here later
    // (or after the toast expired) still has a route to the how-to.
    mockProjectLintData = projectDataWithMarkdownlintRules({ default: true });
    render(
      <TooltipProvider>
        <MarkdownlintPluginSection />
      </TooltipProvider>,
    );
    const docs = screen.getByTestId(
      'settings-plugin-markdownlint-title-docs-link',
    ) as HTMLAnchorElement;
    expect(docs.getAttribute('href')).toBe(
      'https://openknowledge.ai/docs/advanced/content-rules/markdownlint',
    );
    // A link list full of bare "Learn more" tells a screen-reader user nothing;
    // the accessible name names the destination and keeps the visible text.
    expect(docs.getAttribute('aria-label')).toBe('Learn more about markdownlint');
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
