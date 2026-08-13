/**
 * DOM tests for the frontmatter plugin settings panel — the schema BROWSER:
 * every discovered schema file renders as a toggleable row, toggling writes
 * `enabled` mappings to `contentRules` without ever discarding the row's
 * globs, search filters the list, and the Edit button navigates to the file
 * via hash nav.
 */

import type { Config, ConfigBinding, ConfigPatch } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const globalWithDomShims = globalThis as { ResizeObserver?: unknown };
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}
// jsdom does not implement scrollIntoView; cmdk (the folder picker) calls it.
if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {};
}

let mockProjectConfig: Partial<Config> | null = null;
const patches: ConfigPatch[] = [];
const mockBinding = {
  patch: (patch: ConfigPatch) => {
    patches.push(patch);
    return { ok: true, value: { config: mockProjectConfig, appliedPaths: [] } };
  },
} as unknown as ConfigBinding;

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    projectBinding: mockBinding,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: mockProjectConfig,
    projectSynced: true,
    projectLocalConfig: null,
    projectLocalSynced: false,
    merged: null,
  }),
}));

let mockLintData: unknown = null;
let mockDiscovered: string[] = [];
let lintConfigChangedCount = 0;
const created: string[] = [];
const deleted: string[] = [];
vi.doMock('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {
    lintConfigChangedCount += 1;
  },
  subscribeToLintConfigChanged: () => () => {},
  runLintAudit: async () => null,
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: mockLintData }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async () => ({ ok: false, errorDetail: null }),
  writeFrontmatterSchemaField: async () => ({ ok: false, errorDetail: null }),
  useFrontmatterSchemaFiles: () => ({ schemas: mockDiscovered, refresh: () => {} }),
  createEmptyFrontmatterSchema: async (file: string) => {
    created.push(file);
    return { ok: true };
  },
  removeFrontmatterSchemaField: async () => ({ ok: true }),
  renameFrontmatterSchemaField: async () => ({ ok: true }),
  deleteFrontmatterSchema: async (file: string) => {
    deleted.push(file);
    return { ok: true };
  },
}));

// Null (no provider) by default so the folder picker and match-count line stay
// out of the frame for the browser-behavior tests; the picker-wiring tests set
// a value.
let mockPageListValue: { pages: Set<string>; folderPaths: Set<string> } | null = null;
vi.doMock('@/components/PageListContext', () => ({
  useOptionalPageList: () => mockPageListValue,
}));

const { FrontmatterPluginSection } = await import('./LintingSection.tsx');
const { TooltipProvider } = await import('@/components/ui/tooltip');

/**
 * The real app mounts a single TooltipProvider at the root (`main.tsx`), so a
 * flagged pill's tooltip has a provider in production; rendering the section
 * bare does not. Wrap here rather than in each test.
 */
function renderSection() {
  return render(
    <TooltipProvider>
      <FrontmatterPluginSection />
    </TooltipProvider>,
  );
}
// Real module on purpose: the tests assert the banked Fields-view intent the
// schema editor consumes on mount.
const { consumeSchemaFieldsView } = await import('@/lib/schema-fields-view-intent');

function configWithMappings(
  schemas: { appliesTo?: string | string[]; file: string; enabled?: boolean }[],
): Partial<Config> {
  return {
    contentRules: {
      markdownlint: { enabled: false },
      frontmatter: { enabled: true, schemas },
    },
  } as Partial<Config>;
}

function lastSchemas(): { file: string; enabled?: boolean; appliesTo?: unknown }[] {
  const contentRules = patches[patches.length - 1]?.contentRules as {
    frontmatter?: { schemas?: { file: string; enabled?: boolean; appliesTo?: unknown }[] };
  };
  return contentRules.frontmatter?.schemas ?? [];
}

beforeEach(() => {
  cleanup();
  patches.length = 0;
  created.length = 0;
  deleted.length = 0;
  lintConfigChangedCount = 0;
  mockLintData = null;
  mockPageListValue = null;
  mockDiscovered = ['.ok/schemas/doc.schema.json', 'schemas/local.schema.json'];
  mockProjectConfig = configWithMappings([
    { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
  ]);
  window.location.hash = '';
});

describe('FrontmatterPluginSection — schema browser', () => {
  test('links its docs page from the panel header', () => {
    // The standing counterpart to the enable-time toast: the panel itself says
    // where to read up on schema authoring.
    render(<FrontmatterPluginSection />);
    const docs = screen.getByTestId(
      'settings-plugin-frontmatter-title-docs-link',
    ) as HTMLAnchorElement;
    expect(docs.getAttribute('href')).toBe(
      'https://openknowledge.ai/docs/advanced/content-rules/frontmatter',
    );
    // The accessible name is built from the panel title — a wrong `title` would
    // silently say "markdownlint" here, which only this assertion catches.
    expect(docs.getAttribute('aria-label')).toBe('Learn more about Frontmatter schemas');
  });

  test('renders one toggleable row per discovered file', () => {
    renderSection();
    const mapped = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    expect(mapped).toBeTruthy();
    expect(screen.getByTestId('frontmatter-schema-row-schemas/local.schema.json')).toBeTruthy();

    const onToggle = screen.getByTestId(
      'frontmatter-schema-toggle-.ok/schemas/doc.schema.json',
    ) as HTMLButtonElement;
    expect(onToggle.getAttribute('aria-checked')).toBe('true');
    // The enabled row shows its appliesTo pills.
    expect(within(mapped).getByText('docs/**')).toBeTruthy();
  });

  test('toggling an unmapped file on appends an enabled mapping', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('frontmatter-schema-toggle-schemas/local.schema.json'));
    expect(lastSchemas()).toEqual([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
      { file: 'schemas/local.schema.json', enabled: true },
    ]);
    expect(lintConfigChangedCount).toBe(1);
  });

  test('toggling a mapped file off keeps the mapping with enabled: false', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('frontmatter-schema-toggle-.ok/schemas/doc.schema.json'));
    expect(lastSchemas()).toEqual([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: false },
    ]);
  });

  test('a config-mapped file missing from discovery still renders (stays toggleable)', () => {
    mockProjectConfig = configWithMappings([{ file: 'gone/away.schema.json', enabled: true }]);
    renderSection();
    expect(screen.getByTestId('frontmatter-schema-row-gone/away.schema.json')).toBeTruthy();
  });

  test('re-enabling a disabled mapping keeps the globs it was disabled with', () => {
    mockProjectConfig = configWithMappings([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: false },
    ]);
    renderSection();
    fireEvent.click(screen.getByTestId('frontmatter-schema-toggle-.ok/schemas/doc.schema.json'));
    expect(lastSchemas()).toEqual([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
  });

  test('a mapping with no enabled field reads as on, and toggling off pins enabled: false', () => {
    // Hand-authored / pre-toggle configs omit `enabled`; the toggle-only surface
    // treats absent as on. A regression here would silently show a validating
    // schema as toggled off.
    mockProjectConfig = configWithMappings([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json' },
    ]);
    renderSection();
    const toggle = screen.getByTestId(
      'frontmatter-schema-toggle-.ok/schemas/doc.schema.json',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(lastSchemas()).toEqual([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: false },
    ]);
  });

  test('the toggle is the only control — no Modified badge, no reset', () => {
    renderSection();
    expect(
      screen.queryByTestId('frontmatter-schema-modified-.ok/schemas/doc.schema.json'),
    ).toBeNull();
    expect(screen.queryByTestId('frontmatter-schema-reset-.ok/schemas/doc.schema.json')).toBeNull();
    expect(screen.queryByTestId('frontmatter-only-modified')).toBeNull();
    expect(screen.queryByTestId('frontmatter-schema-legend')).toBeNull();
  });

  test('editing appliesTo writes the globs on the file mapping', () => {
    renderSection();
    const input = document.getElementById(
      'frontmatter-schema-applies-.ok/schemas/doc.schema.json',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'notes/**' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lastSchemas()[0]?.appliesTo).toEqual(['docs/**', 'notes/**']);
  });

  test('search filters the rows', () => {
    renderSection();
    fireEvent.change(screen.getByTestId('frontmatter-schema-search'), {
      target: { value: 'local' },
    });
    expect(screen.queryByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json')).toBeNull();
    expect(screen.getByTestId('frontmatter-schema-row-schemas/local.schema.json')).toBeTruthy();

    fireEvent.change(screen.getByTestId('frontmatter-schema-search'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByTestId('frontmatter-schemas-empty').textContent).toContain(
      'No schemas match',
    );
  });

  test('the Edit button opens the file via hash and banks the Fields-view intent', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('frontmatter-schema-edit-.ok/schemas/doc.schema.json'));
    expect(window.location.hash).toBe('#/__asset__/.ok/schemas/doc.schema.json');
    expect(consumeSchemaFieldsView('.ok/schemas/doc.schema.json')).toBe(true);
  });

  test('the schema name is plain text — Edit is the only way into the file', () => {
    renderSection();
    expect(screen.queryByTestId('frontmatter-schema-open-schemas/local.schema.json')).toBeNull();
    fireEvent.click(screen.getByTestId('frontmatter-schema-edit-schemas/local.schema.json'));
    expect(window.location.hash).toBe('#/__asset__/schemas/local.schema.json');
    expect(consumeSchemaFieldsView('schemas/local.schema.json')).toBe(true);
  });

  test('the section header has no maturity tag', () => {
    renderSection();
    const header = document.getElementById('settings-plugin-frontmatter-title')?.parentElement;
    expect(header?.textContent).not.toContain('Beta');
  });

  test('the appliesTo input names the pattern grammar with an example glob', () => {
    mockProjectConfig = configWithMappings([
      { file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    renderSection();
    const input = document.getElementById('frontmatter-schema-applies-.ok/schemas/doc.schema.json');
    expect(input?.getAttribute('placeholder')).toContain('guides/**/*');
    expect(input?.getAttribute('placeholder')).toContain('pattern');
  });

  test('create-schema creates the file in .ok/schemas and maps it enabled', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('frontmatter-create-schema'));
    fireEvent.change(screen.getByTestId('frontmatter-create-schema-name'), {
      target: { value: 'release' },
    });
    fireEvent.click(screen.getByTestId('frontmatter-create-schema-save'));
    await Promise.resolve();
    expect(created).toEqual(['.ok/schemas/release.schema.json']);
    expect(lastSchemas()).toEqual([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
      { file: '.ok/schemas/release.schema.json', enabled: true },
    ]);
  });

  test('frontmatter config problems render for mapped files; others filtered', () => {
    mockLintData = {
      effective: null,
      configProblems: [
        'frontmatter schema .ok/schemas/doc.schema.json: cannot read (ENOENT)',
        'frontmatter schema .ok/schemas/unmapped.json: cannot read (ENOENT)',
        'unmatched appliesTo glob "specs/**" — matches no docs in this project (frontmatter mapping for .ok/schemas/doc.schema.json)',
        '[.markdownlint.json] malformed markdownlint config',
      ],
    };
    renderSection();
    const box = screen.getByTestId('frontmatter-config-problems');
    expect(box.textContent).toContain('doc.schema.json');
    expect(box.textContent).not.toContain('unmapped.json');
    expect(box.textContent).not.toContain('markdownlint config');
    // Glob findings are shown on the glob, never here — see the suite below.
    expect(box.textContent).not.toContain('matches no docs');
  });

  test('the trash affordance confirms, deletes the file, and wipes its mapping', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('frontmatter-schema-delete-.ok/schemas/doc.schema.json'));
    // Nothing happens until the dialog confirms.
    expect(deleted).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(deleted).toEqual(['.ok/schemas/doc.schema.json']);
    expect(lastSchemas()).toEqual([]);
  });

  test('the pills carry a plain-language reading of the globs', () => {
    mockProjectConfig = configWithMappings([
      {
        appliesTo: ['blogs/**/*', '!**/index'],
        file: '.ok/schemas/doc.schema.json',
        enabled: true,
      },
    ]);
    renderSection();
    const summary = screen.getByTestId(
      'frontmatter-schema-applies-summary-.ok/schemas/doc.schema.json',
    );
    expect(summary.textContent).toContain('Applies to');
    expect(summary.textContent).toContain('everything under blogs/');
    expect(summary.textContent).toContain('except');
    expect(summary.textContent).toContain('any doc named index');
  });

  test('empty globs read as every doc', () => {
    mockProjectConfig = configWithMappings([
      { file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    renderSection();
    expect(
      screen.getByTestId('frontmatter-schema-applies-summary-.ok/schemas/doc.schema.json')
        .textContent,
    ).toContain('every doc');
  });

  test('empty state renders when no schemas exist anywhere', () => {
    mockDiscovered = [];
    mockProjectConfig = configWithMappings([]);
    renderSection();
    expect(screen.getByTestId('frontmatter-schemas-empty').textContent).toContain(
      'No schema files in this project yet',
    );
  });
});

describe('FrontmatterPluginSection — glob problems ride on the glob', () => {
  const UNMATCHED_DOCS =
    'unmatched appliesTo glob "docs/**" — matches no docs in this project (frontmatter mapping for .ok/schemas/doc.schema.json)';

  test('an authored pattern carries its own finding instead of the flat list', () => {
    mockLintData = { effective: null, configProblems: [UNMATCHED_DOCS] };
    renderSection();

    const row = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    const flagged = row.querySelectorAll('[data-tag-problem="true"]');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain('docs/**');
    // Shown on the glob, so the list that couldn't say WHICH glob is gone.
    expect(screen.queryByTestId('frontmatter-config-problems')).toBeNull();
  });

  test('schema-level problems still use the list alongside an inline glob finding', () => {
    mockLintData = {
      effective: null,
      configProblems: [
        UNMATCHED_DOCS,
        'frontmatter schema .ok/schemas/doc.schema.json: cannot read (ENOENT)',
      ],
    };
    renderSection();

    const box = screen.getByTestId('frontmatter-config-problems');
    expect(box.textContent).toContain('cannot read');
    expect(box.textContent).not.toContain('matches no docs');
  });

  test('a glob finding never falls back to the list when its row is off screen', () => {
    // One home per finding. Search is transient and author-driven — clearing
    // it brings the pill (and its warning) straight back.
    mockLintData = { effective: null, configProblems: [UNMATCHED_DOCS] };
    renderSection();
    fireEvent.change(screen.getByTestId('frontmatter-schema-search'), {
      target: { value: 'local' },
    });

    expect(screen.queryByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json')).toBeNull();
    expect(screen.queryByTestId('frontmatter-config-problems')).toBeNull();
  });

  test('a finding for a glob that is no longer authored stays out of the list', () => {
    // The reported bug: deleting a red glob removed the pill, and the finding
    // — still live because the config channel is composed from the on-disk
    // config.yml and lags the CRDT write — surfaced in the list for a moment
    // before the next lint cleared it. It read as a warning about a pattern
    // that no longer existed. This is that window: config already has the
    // glob gone, the server has not caught up.
    mockProjectConfig = configWithMappings([
      { appliesTo: ['other/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    mockLintData = { effective: null, configProblems: [UNMATCHED_DOCS] };
    renderSection();

    expect(screen.queryByTestId('frontmatter-config-problems')).toBeNull();
    const row = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    expect(row.querySelectorAll('[data-tag-problem="true"]')).toHaveLength(0);
  });

  test('a stale finding does not redden whichever glob happens to remain', () => {
    // Matching is by exact pattern, so the surviving entry must not inherit a
    // deleted sibling's warning.
    mockProjectConfig = configWithMappings([
      { appliesTo: ['other/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    mockLintData = { effective: null, configProblems: [UNMATCHED_DOCS] };
    renderSection();

    const row = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    const pills = [...row.querySelectorAll('[data-slot="tag-pill-input"] button')].filter(
      (el) => el.textContent !== '',
    );
    expect(pills.map((p) => p.textContent)).toEqual(['other/**']);
    expect(row.querySelector('[data-tag-problem="true"]')).toBeNull();
  });

  test('editing a flagged glob writes the corrected pattern in place', () => {
    mockProjectConfig = configWithMappings([
      {
        appliesTo: ['blog', '!blog/drafts/**'],
        file: '.ok/schemas/doc.schema.json',
        enabled: true,
      },
    ]);
    mockLintData = {
      effective: null,
      configProblems: [
        'unmatched appliesTo glob "blog" — matches no docs in this project (frontmatter mapping for .ok/schemas/doc.schema.json)',
      ],
    };
    renderSection();

    const row = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    // Not `[data-slot="badge"] span`: a flagged pill is wrapped in a Radix
    // TooltipTrigger with `asChild`, whose own data-slot replaces the badge's.
    const pill = [...row.querySelectorAll('[data-slot="tag-pill-input"] button')].find(
      (el) => el.textContent === 'blog',
    ) as HTMLElement;
    fireEvent.doubleClick(pill);
    const input = row.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('blog');
    fireEvent.change(input, { target: { value: 'blog/**' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(lastSchemas()).toEqual([
      {
        appliesTo: ['blog/**', '!blog/drafts/**'],
        file: '.ok/schemas/doc.schema.json',
        enabled: true,
      },
    ]);
  });
});

describe('FrontmatterPluginSection — findings with no pill to land on', () => {
  // A row binds to the FIRST mapping for its file and only mounts the glob
  // input when that mapping is enabled, but the server reports problems per
  // mapping entry. These shapes have no pill that can ever carry the finding,
  // so suppressing them would silently unvalidate docs that are governed.
  const UNMATCHED_B =
    'unmatched appliesTo glob "b/**" — matches no docs in this project (frontmatter mapping for .ok/schemas/doc.schema.json)';

  test('a second mapping for the same file keeps its finding in the list', () => {
    mockProjectConfig = configWithMappings([
      { appliesTo: ['a/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
      { appliesTo: ['b/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    mockLintData = { effective: null, configProblems: [UNMATCHED_B] };
    renderSection();

    const row = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    expect(row.textContent).toContain('a/**');
    expect(row.textContent).not.toContain('b/**');
    expect(screen.getByTestId('frontmatter-config-problems').textContent).toContain(
      'matches no docs',
    );
  });

  test('an enabled mapping behind a disabled first one keeps its finding in the list', () => {
    // The row binds to the disabled mapping, so the glob input never mounts.
    mockProjectConfig = configWithMappings([
      { file: '.ok/schemas/doc.schema.json', enabled: false },
      { appliesTo: ['b/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    mockLintData = { effective: null, configProblems: [UNMATCHED_B] };
    renderSection();

    const row = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    expect(row.querySelector('[data-slot="tag-pill-input"]')).toBeNull();
    expect(screen.getByTestId('frontmatter-config-problems').textContent).toContain(
      'matches no docs',
    );
  });

  test('a pattern the bound enabled mapping carries stays out of the list', () => {
    // The pill is where this finding lives — including while search hides the
    // row, which is the trade-off this surface deliberately keeps.
    mockProjectConfig = configWithMappings([
      { appliesTo: ['b/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    mockLintData = { effective: null, configProblems: [UNMATCHED_B] };
    renderSection();
    expect(screen.queryByTestId('frontmatter-config-problems')).toBeNull();

    fireEvent.change(screen.getByTestId('frontmatter-schema-search'), {
      target: { value: 'local' },
    });
    expect(screen.queryByTestId('frontmatter-config-problems')).toBeNull();
  });
});

describe('FrontmatterPluginSection — folder picker + live match count', () => {
  const FILE = '.ok/schemas/doc.schema.json';

  function withPages() {
    mockPageListValue = {
      pages: new Set(['blog/a', 'blog/nested/b', 'docs/c', 'root-doc']),
      folderPaths: new Set(['blog', 'blog/nested', 'docs']),
    };
  }

  test('without a page-list provider, neither picker nor count renders', () => {
    renderSection();
    expect(screen.queryByTestId(`frontmatter-schema-pick-folders-${FILE}`)).toBeNull();
    expect(screen.queryByTestId(`frontmatter-schema-match-count-${FILE}`)).toBeNull();
  });

  test('checking a folder appends its recursive glob to the mapping', () => {
    withPages();
    renderSection();
    fireEvent.click(screen.getByTestId(`frontmatter-schema-pick-folders-${FILE}`));
    fireEvent.click(screen.getByTestId(`frontmatter-schema-folder-item-${FILE}-blog`));
    expect(lastSchemas()[0]?.appliesTo).toEqual(['docs/**', 'blog/**']);
  });

  test('unchecking a picked folder removes its glob from the mapping', () => {
    withPages();
    renderSection();
    fireEvent.click(screen.getByTestId(`frontmatter-schema-pick-folders-${FILE}`));
    fireEvent.click(screen.getByTestId(`frontmatter-schema-folder-item-${FILE}-docs`));
    // The mapping's only glob is gone — appliesTo drops entirely (every doc).
    expect(lastSchemas()[0]?.appliesTo).toBeUndefined();
  });

  test('the summary line counts matched docs live', () => {
    withPages();
    renderSection();
    expect(screen.getByTestId(`frontmatter-schema-match-count-${FILE}`).textContent).toContain(
      'Matches 1 of 4 docs right now.',
    );
  });

  test('a pattern matching nothing reads 0 — the bare-folder-name trap is visible', () => {
    withPages();
    mockProjectConfig = configWithMappings([{ appliesTo: ['blog'], file: FILE, enabled: true }]);
    renderSection();
    expect(screen.getByTestId(`frontmatter-schema-match-count-${FILE}`).textContent).toContain(
      'Matches 0 of 4 docs right now.',
    );
  });

  test('a zero-match bare folder still teaches /** beside a live sibling pattern', () => {
    withPages();
    mockProjectConfig = configWithMappings([
      { appliesTo: ['blog', 'docs/**'], file: FILE, enabled: true },
    ]);
    renderSection();

    const matchCount = screen.getByTestId(`frontmatter-schema-match-count-${FILE}`);
    expect(matchCount.textContent).toContain('Matches 1 of 4 docs right now.');
    expect(matchCount.textContent).toContain(
      "(a bare folder name needs /** after it to match what's inside)",
    );
  });
});
