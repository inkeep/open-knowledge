/**
 * DOM tests for the frontmatter plugin settings panel — the schema BROWSER:
 * every discovered schema file renders as a toggleable row, toggling writes
 * `enabled` mappings to `contentRules`, reset wipes a mapping, search filters
 * the list, and the Edit button navigates to the file via hash nav.
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

const { FrontmatterPluginSection } = await import('./LintingSection.tsx');
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
  mockDiscovered = ['.ok/schemas/doc.schema.json', 'schemas/local.schema.json'];
  mockProjectConfig = configWithMappings([
    { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
  ]);
  window.location.hash = '';
});

describe('FrontmatterPluginSection — schema browser', () => {
  test('renders one toggleable row per discovered file; mapped rows are Modified', () => {
    render(<FrontmatterPluginSection />);
    const mapped = screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json');
    expect(mapped).toBeTruthy();
    expect(screen.getByTestId('frontmatter-schema-row-schemas/local.schema.json')).toBeTruthy();
    expect(
      screen.getByTestId('frontmatter-schema-modified-.ok/schemas/doc.schema.json'),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('frontmatter-schema-modified-schemas/local.schema.json'),
    ).toBeNull();

    const onToggle = screen.getByTestId(
      'frontmatter-schema-toggle-.ok/schemas/doc.schema.json',
    ) as HTMLButtonElement;
    expect(onToggle.getAttribute('aria-checked')).toBe('true');
    // The enabled row shows its appliesTo pills.
    expect(within(mapped).getByText('docs/**')).toBeTruthy();
  });

  test('toggling an unmapped file on appends an enabled mapping', () => {
    render(<FrontmatterPluginSection />);
    fireEvent.click(screen.getByTestId('frontmatter-schema-toggle-schemas/local.schema.json'));
    expect(lastSchemas()).toEqual([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: true },
      { file: 'schemas/local.schema.json', enabled: true },
    ]);
    expect(lintConfigChangedCount).toBe(1);
  });

  test('toggling a mapped file off keeps the mapping with enabled: false', () => {
    render(<FrontmatterPluginSection />);
    fireEvent.click(screen.getByTestId('frontmatter-schema-toggle-.ok/schemas/doc.schema.json'));
    expect(lastSchemas()).toEqual([
      { appliesTo: ['docs/**'], file: '.ok/schemas/doc.schema.json', enabled: false },
    ]);
  });

  test('a config-mapped file missing from discovery still renders (reset stays reachable)', () => {
    mockProjectConfig = configWithMappings([{ file: 'gone/away.schema.json', enabled: true }]);
    render(<FrontmatterPluginSection />);
    expect(screen.getByTestId('frontmatter-schema-row-gone/away.schema.json')).toBeTruthy();
  });

  test('reset wipes the mapping from config entirely', () => {
    render(<FrontmatterPluginSection />);
    fireEvent.click(screen.getByTestId('frontmatter-schema-reset-.ok/schemas/doc.schema.json'));
    expect(lastSchemas()).toEqual([]);
  });

  test('editing appliesTo writes the globs on the file mapping', () => {
    render(<FrontmatterPluginSection />);
    const input = document.getElementById(
      'frontmatter-schema-applies-.ok/schemas/doc.schema.json',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'notes/**' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lastSchemas()[0]?.appliesTo).toEqual(['docs/**', 'notes/**']);
  });

  test('search filters the rows', () => {
    render(<FrontmatterPluginSection />);
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
    render(<FrontmatterPluginSection />);
    fireEvent.click(screen.getByTestId('frontmatter-schema-edit-.ok/schemas/doc.schema.json'));
    expect(window.location.hash).toBe('#/__asset__/.ok/schemas/doc.schema.json');
    expect(consumeSchemaFieldsView('.ok/schemas/doc.schema.json')).toBe(true);
  });

  test('the schema name is plain text — Edit is the only way into the file', () => {
    render(<FrontmatterPluginSection />);
    expect(screen.queryByTestId('frontmatter-schema-open-schemas/local.schema.json')).toBeNull();
    fireEvent.click(screen.getByTestId('frontmatter-schema-edit-schemas/local.schema.json'));
    expect(window.location.hash).toBe('#/__asset__/schemas/local.schema.json');
    expect(consumeSchemaFieldsView('schemas/local.schema.json')).toBe(true);
  });

  test('the section header carries the feature-beta tag', () => {
    render(<FrontmatterPluginSection />);
    const header = document.getElementById('settings-plugin-frontmatter-title')?.parentElement;
    expect(header?.textContent).toContain('Beta');
  });

  test('the appliesTo input names the pattern grammar with an example glob', () => {
    mockProjectConfig = configWithMappings([
      { file: '.ok/schemas/doc.schema.json', enabled: true },
    ]);
    render(<FrontmatterPluginSection />);
    const input = document.getElementById('frontmatter-schema-applies-.ok/schemas/doc.schema.json');
    expect(input?.getAttribute('placeholder')).toContain('guides/**/*');
    expect(input?.getAttribute('placeholder')).toContain('pattern');
  });

  test('create-schema creates the file in .ok/schemas and maps it enabled', async () => {
    render(<FrontmatterPluginSection />);
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
    render(<FrontmatterPluginSection />);
    const box = screen.getByTestId('frontmatter-config-problems');
    expect(box.textContent).toContain('doc.schema.json');
    expect(box.textContent).toContain('matches no docs');
    expect(box.textContent).not.toContain('unmapped.json');
    expect(box.textContent).not.toContain('markdownlint config');
  });

  test('the trash affordance confirms, deletes the file, and wipes its mapping', async () => {
    render(<FrontmatterPluginSection />);
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
    render(<FrontmatterPluginSection />);
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
    render(<FrontmatterPluginSection />);
    expect(
      screen.getByTestId('frontmatter-schema-applies-summary-.ok/schemas/doc.schema.json')
        .textContent,
    ).toContain('every doc');
  });

  test('the only-modified filter narrows to mapped schemas', () => {
    render(<FrontmatterPluginSection />);
    fireEvent.click(screen.getByTestId('frontmatter-only-modified'));
    expect(screen.getByTestId('frontmatter-schema-row-.ok/schemas/doc.schema.json')).toBeTruthy();
    expect(screen.queryByTestId('frontmatter-schema-row-schemas/local.schema.json')).toBeNull();
  });

  test('empty state renders when no schemas exist anywhere', () => {
    mockDiscovered = [];
    mockProjectConfig = configWithMappings([]);
    render(<FrontmatterPluginSection />);
    expect(screen.getByTestId('frontmatter-schemas-empty').textContent).toContain(
      'No schema files in this project yet',
    );
  });
});
