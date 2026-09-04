import {
  type Config,
  type ConfigBinding,
  OKF_RULE_GROUPS,
  OKF_RULE_IDS,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { LINT_PLUGIN_META } from './lint-plugin-meta';
import { describedTextOf } from './settings-a11y.test-helper';

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
const generatedIndexApiCalls: boolean[] = [];
let mockGeneratedIndexActive: boolean | null = null;
let mockGeneratedIndexGitState:
  | 'not-applicable'
  | 'ready'
  | 'missing'
  | 'conflict'
  | 'unavailable'
  | null = null;
let mockGeneratedIndexApplyResult: {
  applied: boolean;
  reason?: 'git-conflict' | 'git-unavailable' | 'config-write';
} | null = null;
let mockGeneratedIndexFetchRejects = false;
let mockSkillsState:
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: readonly SkillsListEntry[] }
  | { status: 'error'; message: string } = { status: 'ready', data: [] };
const installPackSkillCalls: string[] = [];
const openSkillCalls: Array<[string, string]> = [];
let installPackSkillResult:
  | { ok: true; skills: Array<{ name: string; created: boolean }>; installedHosts: string[] }
  | { ok: false; error: string } = {
  ok: true,
  skills: [{ name: 'okf-knowledge-base', created: true }],
  installedHosts: ['Claude Code'],
};

function configuredGeneratedIndexEnabled(): boolean {
  return mockProjectConfig?.contentRules?.okf?.generate?.index === true;
}

async function generatedIndexFetch(input: string | URL | Request, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== '/api/generated-index/settings') throw new TypeError(`unmocked fetch: ${url}`);
  if (mockGeneratedIndexFetchRejects) throw new TypeError('Failed to fetch');

  const requested =
    init?.method === 'POST'
      ? (JSON.parse(String(init.body)) as { enabled: boolean }).enabled
      : configuredGeneratedIndexEnabled();
  if (init?.method === 'POST') generatedIndexApiCalls.push(requested);
  const applyResult =
    init?.method === 'POST' ? (mockGeneratedIndexApplyResult ?? { applied: true }) : {};
  const effectiveEnabled =
    'applied' in applyResult && applyResult.applied === false
      ? configuredGeneratedIndexEnabled()
      : requested;
  return new Response(
    JSON.stringify({
      enabled: effectiveEnabled,
      active: mockGeneratedIndexActive ?? effectiveEnabled,
      git: { state: mockGeneratedIndexGitState ?? 'not-applicable' },
      ...applyResult,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

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
    return { ok: true, response: mockProjectLintData };
  },
}));

vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => mockSkillsState,
}));

vi.doMock('@/hooks/use-open-skill', () => ({
  useOpenSkill: () => (scope: string, name: string) => {
    openSkillCalls.push([scope, name]);
  },
}));

vi.doMock('@/lib/skills-api', () => ({
  installPackSkill: async (packId: string) => {
    installPackSkillCalls.push(packId);
    return installPackSkillResult;
  },
}));

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
const errorToasts: string[] = [];
vi.doMock('sonner', () => ({
  toast: {
    success: (message: string, options?: ToastOptions) => {
      successToasts.push({ message, ...options });
    },
    error: (message: string) => {
      errorToasts.push(message);
    },
  },
}));

const {
  ProjectPluginsManageSection,
  UserPluginsManageSection,
  MarkdownlintPluginSection,
  OkfPluginSection,
} = await import('./LintingSection');

interface SliceOverrides {
  markdownlint?: Record<string, unknown>;
  okf?: Record<string, unknown>;
}

function configWith(linter: SliceOverrides): Config {
  return {
    contentRules: {
      markdownlint: { enabled: true, ...linter.markdownlint },
      ...(linter.okf === undefined ? {} : { okf: { enabled: true, ...linter.okf } }),
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
  generatedIndexApiCalls.length = 0;
  mockGeneratedIndexActive = null;
  mockGeneratedIndexGitState = null;
  mockGeneratedIndexApplyResult = null;
  mockGeneratedIndexFetchRejects = false;
  installPackSkillCalls.length = 0;
  openSkillCalls.length = 0;
  errorToasts.length = 0;
  mockSkillsState = { status: 'ready', data: [] };
  installPackSkillResult = {
    ok: true,
    skills: [{ name: 'okf-knowledge-base', created: true }],
    installedHosts: ['Claude Code'],
  };
  vi.stubGlobal('fetch', generatedIndexFetch);
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProjectPluginsManageSection', () => {
  test('renders the project plugin toggles and points project audits at the Problems panel', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);
    expect(screen.getByTestId('settings-plugin-toggle-markdownlint')).toBeDefined();
    expect(screen.queryByTestId('settings-plugin-toggle-theme')).toBeNull();
    expect(screen.queryByTestId('settings-linting-audit')).toBeNull();
    expect(screen.getByTestId('settings-plugins-audit-pointer').textContent).toContain(
      'Run a project audit from the Problems panel',
    );
    const list = screen.getByTestId('settings-plugins-list');
    const labelled = (badge: HTMLElement) => badge.closest('label')?.textContent ?? '';
    const tagged = within(list).getAllByText('Beta').map(labelled).sort();
    const expected = LINT_PLUGIN_META.filter((plugin) => plugin.beta).map((plugin) => plugin.label);
    expect(tagged).toHaveLength(expected.length);
    for (const label of expected) {
      expect(tagged.some((text) => text.includes(label))).toBe(true);
    }
    expect(tagged.some((text) => text.includes('markdownlint'))).toBe(false);
  });

  test('every plugin toggle is described by its own row description', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);

    expect(describedTextOf('settings-plugin-toggle-markdownlint')).toContain(
      'Common markdown issues',
    );
    expect(describedTextOf('settings-plugin-toggle-frontmatter')).toContain(
      'Validate document frontmatter',
    );
    expect(describedTextOf('settings-plugin-toggle-okf')).toBe(
      'Keeps your knowledge base aligned with the Open Knowledge Format.',
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

  test('renders the okf plugin row with an off toggle and a concise description', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);
    const toggle = screen.getByTestId('settings-plugin-toggle-okf');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const row = toggle.closest('div');
    expect(row?.textContent).toContain(
      'Keeps your knowledge base aligned with the Open Knowledge Format.',
    );
  });

  test('toggling the okf plugin writes its enabled patch', async () => {
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    render(<ProjectPluginsManageSection />);
    await userEvent.click(screen.getByTestId('settings-plugin-toggle-okf'));
    expect(calls).toContainEqual({
      contentRules: { okf: { enabled: true } },
    });
  });

  test('enabling a plugin offers its settings panel, and the offer deep-links there', async () => {
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

  test('every user-scope toggle is described by its row description, like the project rows', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    render(<UserPluginsManageSection userBinding={null} />);

    expect(describedTextOf('settings-plugin-toggle-theme')).toContain(
      'A personal color-theme picker',
    );
    expect(describedTextOf('settings-plugin-toggle-slides')).toContain(
      'Present a document as a slide deck',
    );
  });

  test('the Themes toggle writes the user-scope enabled patch', async () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    const { binding: userBinding, calls: userCalls } = makeBinding();
    render(<UserPluginsManageSection userBinding={userBinding} />);
    await userEvent.click(screen.getByTestId('settings-plugin-toggle-theme'));
    expect(userCalls).toContainEqual({ appearance: { colorThemeEnabled: false } });
    expect(successToasts).toHaveLength(0);
  });

  test('re-enabling Themes offers its panel too (the user-scope plugin is not special-cased)', async () => {
    const { binding: userBinding } = makeBinding();
    mockUserConfig = { appearance: { colorThemeEnabled: false } } as unknown as Config;
    render(<UserPluginsManageSection userBinding={userBinding} />);

    await userEvent.click(screen.getByTestId('settings-plugin-toggle-theme'));

    expect(successToasts).toHaveLength(1);
    expect(successToasts[0]?.message).toBe('Themes enabled');
    successToasts[0]?.action?.onClick();
    expect(window.location.hash).toBe('#settings/plugin:theme');
  });

  test('lists a user-scope Slides toggle beside Themes and labels Slidev as beta', () => {
    render(<UserPluginsManageSection userBinding={null} />);
    expect(screen.getByTestId('settings-plugin-toggle-slides')).toBeDefined();
    expect(screen.getByTestId('settings-plugin-toggle-theme')).toBeDefined();
    expect(screen.getByText('Slidev').closest('label')?.textContent).toContain('Beta');
  });

  test('enabling Slides writes the user-scope enabled patch and offers its panel', async () => {
    const { binding: userBinding, calls: userCalls } = makeBinding();
    render(<UserPluginsManageSection userBinding={userBinding} />);

    await userEvent.click(screen.getByTestId('settings-plugin-toggle-slides'));

    expect(userCalls).toContainEqual({ slides: { enabled: true } });
    expect(successToasts).toHaveLength(1);
    expect(successToasts[0]?.message).toBe('Slidev enabled');
    successToasts[0]?.action?.onClick();
    expect(window.location.hash).toBe('#settings/plugin:slides');
  });

  test('disabling Slides writes enabled:false and does not offer its panel', async () => {
    const { binding: userBinding, calls: userCalls } = makeBinding();
    mockUserConfig = { slides: { enabled: true } } as unknown as Config;
    render(<UserPluginsManageSection userBinding={userBinding} />);

    await userEvent.click(screen.getByTestId('settings-plugin-toggle-slides'));

    expect(userCalls).toContainEqual({ slides: { enabled: false } });
    expect(successToasts).toHaveLength(0);
  });
});

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
    expect(screen.getByTestId('settings-scope-badge-project')).toBeDefined();
    expect(screen.queryByTestId('settings-scope-badge-user')).toBeNull();
  });

  test('links its docs page from the panel header', () => {
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
    expect(docs.getAttribute('aria-label')).toBe('Learn more about markdownlint');
  });

  test('names the project config file in the description when one is present', () => {
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

describe('OkfPluginSection', () => {
  function renderPanel() {
    render(
      <TooltipProvider>
        <OkfPluginSection />
      </TooltipProvider>,
    );
  }

  async function generatedIndexToggle(): Promise<HTMLButtonElement> {
    const toggle = screen.getByTestId('settings-okf-generate-index') as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    return toggle;
  }

  test('renders the okf plugin panel with its identity header and concise description', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    renderPanel();
    const panel = screen.getByTestId('settings-plugin-okf');
    expect(panel).toBeDefined();
    expect(within(panel).getByText('OKF')).toBeDefined();
    expect(screen.getByTestId('settings-scope-badge-project')).toBeDefined();
    expect(screen.queryByTestId('settings-scope-badge-user')).toBeNull();
    expect(panel.textContent).toContain(
      'Keeps your knowledge base aligned with the Open Knowledge Format.',
    );
  });

  test('the header carries the Beta tag and a link to the plugin docs', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    renderPanel();
    const panel = screen.getByTestId('settings-plugin-okf');
    expect(within(panel).getByText('Beta')).toBeDefined();
    const docsLink = screen.getByTestId('settings-plugin-okf-title-docs-link');
    expect(docsLink.getAttribute('href')).toBe(
      LINT_PLUGIN_META.find((plugin) => plugin.id === 'okf')?.docUrl,
    );
  });

  test('offers the declared OKF agent skill as an explicit install', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    renderPanel();

    const card = screen.getByTestId('settings-okf-recommended-skill');
    expect(screen.getByRole('heading', { name: 'Recommended agent skill' })).toBeDefined();
    expect(card.textContent).toContain('Open Knowledge Format guidance');
    expect(within(card).getByRole('button', { name: 'Install skill' })).toBeDefined();
  });

  test('reuses the skill-bundle picker before installing the OKF skill', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Install skill' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install from OKF' });
    expect(within(dialog).getByTestId('plugin-bundle-install')).toBeDefined();
    expect(within(dialog).getByText('Installs into this project')).toBeDefined();
    expect(dialog.textContent).not.toContain('Install into');
    expect(dialog.textContent).toContain('okf-knowledge-base');
    expect(installPackSkillCalls).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Install 1 skill' }));

    await waitFor(() => expect(installPackSkillCalls).toEqual(['okf']));
    expect(successToasts.at(-1)?.message).toContain('OKF agent skill installed');
    expect(screen.getByTestId('settings-okf-recommended-skill').textContent).toContain('Installed');
  });

  test('recognizes a same-name project skill without claiming or overwriting it', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    mockSkillsState = {
      status: 'ready',
      data: [
        {
          name: 'okf-knowledge-base',
          description: 'Team-authored OKF conventions',
          scope: 'project',
          path: '.agents/skills/okf-knowledge-base/SKILL.md',
          installed: true,
          hosts: ['agents'],
        },
      ],
    };
    renderPanel();

    const card = screen.getByTestId('settings-okf-recommended-skill');
    expect(card.textContent).toContain('Already in project');
    expect(within(card).queryByRole('button', { name: 'Install skill' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Open skill' }));
    expect(openSkillCalls).toEqual([['project', 'okf-knowledge-base']]);
    expect(installPackSkillCalls).toEqual([]);
  });

  test('surfaces install failure and leaves the action available', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    installPackSkillResult = { ok: false, error: 'Skill source could not be authored.' };
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Install skill' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Install 1 skill' }),
    );

    await waitFor(() => expect(errorToasts).toContain('Skill source could not be authored.'));
    expect(screen.getByTestId('settings-okf-recommended-skill').textContent).not.toContain(
      'Installed',
    );

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Install skill' })),
    );
    expect(screen.getByRole('button', { name: 'Install skill' })).toBeDefined();
  });

  test('renders a switch per registered rule, all on when config says nothing', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    renderPanel();
    const list = screen.getByTestId('settings-okf-rules-list');
    for (const id of OKF_RULE_IDS) {
      const toggle = within(list).getByTestId(`settings-okf-rule-toggle-${id}`);
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    }
    expect(screen.getByTestId('settings-plugin-okf').textContent).toContain(
      `${OKF_RULE_IDS.length}/${OKF_RULE_IDS.length} on`,
    );
  });

  test('rules render inside their declared group, and every rule is reachable through one', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    renderPanel();

    const seen: string[] = [];
    for (const group of OKF_RULE_GROUPS) {
      const block = screen.getByTestId(`settings-okf-rule-group-${group.id}`);
      for (const id of group.ids) {
        expect(within(block).getByTestId(`settings-okf-rule-toggle-${id}`)).toBeDefined();
        seen.push(id);
      }
      expect(block.textContent?.length ?? 0).toBeGreaterThan(group.ids.join('').length);
    }
    expect([...seen].sort()).toEqual([...OKF_RULE_IDS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('a rule set to false in config renders off, its siblings stay on', () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: { rules: { 'no-wiki-links': false } } });
    renderPanel();
    expect(
      screen.getByTestId('settings-okf-rule-toggle-no-wiki-links').getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByTestId('settings-okf-rule-toggle-index-shape').getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByTestId('settings-plugin-okf').textContent).toContain(
      `${OKF_RULE_IDS.length - 1}/${OKF_RULE_IDS.length} on`,
    );
  });

  test('turning a rule off sends that rule as false', async () => {
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: { rules: { 'log-shape': false } } });
    renderPanel();
    await userEvent.click(screen.getByTestId('settings-okf-rule-toggle-index-shape'));
    expect(calls).toContainEqual({
      contentRules: { okf: { rules: { 'index-shape': false } } },
    });
  });

  test('turning a rule back on sends null, which deletes the key', async () => {
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: { rules: { 'index-shape': false } } });
    renderPanel();
    await userEvent.click(screen.getByTestId('settings-okf-rule-toggle-index-shape'));
    expect(calls).toContainEqual({
      contentRules: { okf: { rules: { 'index-shape': null } } },
    });
  });

  test('rule switches are disabled until the config binding is ready', () => {
    mockProjectBinding = null;
    mockProjectSynced = false;
    renderPanel();
    const toggle = screen.getByTestId('settings-okf-rule-toggle-index-shape') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  test('enabling generation asks for confirmation before writing any file', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: {} });
    renderPanel();

    await user.click(await generatedIndexToggle());

    const dialog = await screen.findByRole('dialog', {
      name: 'Maintain generated indexes in every folder?',
    });
    expect(dialog.textContent).toContain('index.md');
    expect(dialog.textContent).toContain('.gitattributes');
    expect(dialog.textContent).toMatch(/every folder/i);
    expect(dialog.querySelector('[data-slot="dialog-body"]')).not.toBeNull();
    const note = within(dialog).getByRole('note');
    expect(note.textContent).toContain('Heads up');
    expect(note.textContent).toContain('Generated files');
    expect(note.textContent).toContain('Git merge rule');
    expect(note.textContent).toContain('Turning it off');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Enable indexes' })).toBeDefined();
    expect(calls).toEqual([]);
    expect(generatedIndexApiCalls).toEqual([]);
    expect(screen.getByTestId('settings-okf-generate-index').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('the confirmation footer weights the confirm above the dismiss', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: {} });
    renderPanel();

    await user.click(await generatedIndexToggle());
    const dialog = await screen.findByRole('dialog', {
      name: 'Maintain generated indexes in every folder?',
    });

    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByTestId('settings-okf-generate-index-confirm-accept');

    expect(cancel.getAttribute('data-variant')).toBe('outline');
    expect(confirm.getAttribute('data-variant')).toBe('default');
    expectVisualClassTokens(confirm.className, [
      'font-mono',
      'uppercase',
      'bg-primary',
      'text-primary-foreground',
    ]);
  });

  test('declining the confirmation leaves generation off and writes nothing', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: {} });
    renderPanel();

    await user.click(await generatedIndexToggle());
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(calls).toEqual([]);
    expect(generatedIndexApiCalls).toEqual([]);
    expect(screen.getByTestId('settings-okf-generate-index').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('confirming the disclosure coordinates enablement through the settings endpoint', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: {} });
    renderPanel();

    await user.click(await generatedIndexToggle());
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('settings-okf-generate-index-confirm-accept'));

    await waitFor(() => expect(generatedIndexApiCalls).toEqual([true]));
    expect(calls).toEqual([]);
  });

  test('disabling generation uses the settings endpoint with no confirmation or index removal', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: { generate: { index: true } } });
    renderPanel();

    await user.click(await generatedIndexToggle());

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(generatedIndexApiCalls).toEqual([false]));
    expect(calls).toEqual([]);
  });

  test('an enabled setting stays on and can be disabled when Git admission degrades', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: { generate: { index: true } } });
    mockGeneratedIndexActive = false;
    renderPanel();

    const toggle = await generatedIndexToggle();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(generatedIndexApiCalls).toEqual([false]));
  });

  test('a config that could not be saved says so rather than reporting generation on', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: {} });
    mockGeneratedIndexApplyResult = { applied: false, reason: 'config-write' };
    renderPanel();

    await user.click(await generatedIndexToggle());
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('settings-okf-generate-index-confirm-accept'));

    const notice = await screen.findByTestId('settings-okf-generate-index-status');
    expect(notice.textContent).toContain('the project setting could not be saved');
    expect(screen.getByTestId('settings-okf-generate-index').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('an unreachable project server reads as a connection problem, not a silent no-op', async () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: {} });
    mockGeneratedIndexFetchRejects = true;
    renderPanel();

    const notice = await screen.findByTestId('settings-okf-generate-index-status');
    expect(notice.textContent).toContain('could not reach the project server');
  });

  test('an unconfirmable Git merge rule pauses generation and names Git as the cause', async () => {
    const { binding } = makeBinding();
    mockProjectBinding = binding;
    mockProjectConfig = configWith({ okf: { generate: { index: true } } });
    mockGeneratedIndexGitState = 'unavailable';
    mockGeneratedIndexActive = false;
    renderPanel();

    const notice = await screen.findByTestId('settings-okf-generate-index-status');
    expect(notice.textContent).toContain('could not confirm the required Git merge rule');
    expect(notice.textContent).not.toContain('another Git attribute');
  });
});
