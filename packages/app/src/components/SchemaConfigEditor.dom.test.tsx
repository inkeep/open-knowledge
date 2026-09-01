import { act, cleanup, render, screen } from '@testing-library/react';
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
const MAPPED_SCHEMA = '.ok/schemas/doc.schema.json';
const OTHER_MAPPED_SCHEMA = '.ok/schemas/blog.schema.json';
const UNMAPPED_SCHEMA = '.ok/schemas/orphan.schema.json';
const DRAIN_SENTINEL = '.ok/schemas/__drain__.schema.json';

let mockMappedFiles: string[] = [];

vi.doMock('@/editor/lint-config-client', () => ({
  useProjectLintConfig: () => ({
    data: {
      effective: {
        enabled: true,
        plugins: {
          markdownlint: { enabled: false, rules: {} },
          frontmatter: {
            enabled: true,
            schemas: mockMappedFiles.map((file) => ({ file, key: file })),
          },
        },
      },
      configFile: null,
      configProblems: [],
    },
  }),
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

vi.doMock('@/components/settings/frontmatter-schema-field-editor', () => ({
  FrontmatterSchemaFieldEditor: (props: { file: string }) => (
    <div data-testid="mock-field-editor" data-file={props.file} />
  ),
}));

vi.doMock('@/components/NotInSidebarIndicator', () => ({
  NotInSidebarIndicator: (props: { entry: unknown }) => (
    <div data-testid="mock-not-in-sidebar" data-entry={JSON.stringify(props.entry)} />
  ),
}));

const { SchemaConfigEditor } = await import('./SchemaConfigEditor');

function renderEditor(assetPath: string) {
  return render(
    <TooltipProvider>
      <SchemaConfigEditor assetPath={assetPath} />
    </TooltipProvider>,
  );
}

function fieldsSegment(): HTMLButtonElement {
  return screen.getByLabelText('Fields') as HTMLButtonElement;
}
function sourceSegment(): HTMLButtonElement {
  return screen.getByLabelText('Source') as HTMLButtonElement;
}

beforeEach(async () => {
  localStorage.clear();
  mockMappedFiles = [MAPPED_SCHEMA, OTHER_MAPPED_SCHEMA];
  const { requestSchemaFieldsView, consumeSchemaFieldsView } = await import(
    '@/lib/schema-fields-view-intent'
  );
  requestSchemaFieldsView(DRAIN_SENTINEL);
  consumeSchemaFieldsView(DRAIN_SENTINEL);
});

afterEach(() => {
  cleanup();
});

describe('SchemaConfigEditor — toggle and default view', () => {
  test('renders a Source/Fields toggle without a maturity tag and defaults to Source', () => {
    renderEditor(MAPPED_SCHEMA);

    expect(fieldsSegment()).toBeDefined();
    expect(sourceSegment()).toBeDefined();
    expect(screen.queryByText('Beta')).toBeNull();

    const viewer = screen.getByTestId('mock-text-viewer');
    expect(viewer.getAttribute('data-src')).toBe(
      `/api/asset-text?path=${encodeURIComponent(MAPPED_SCHEMA)}`,
    );
    expect(viewer.getAttribute('data-extension')).toBe('json');
    expect(screen.queryByTestId('mock-field-editor')).toBeNull();

    expect(screen.getByTestId('mock-not-in-sidebar').getAttribute('data-entry')).toBe(
      JSON.stringify({ kind: 'asset', path: MAPPED_SCHEMA }),
    );
  });
});

describe('SchemaConfigEditor — Settings-open Fields intent', () => {
  test('a banked Fields intent opens the mapped schema on Fields, once, without persisting', async () => {
    const { requestSchemaFieldsView } = await import('@/lib/schema-fields-view-intent');
    requestSchemaFieldsView(MAPPED_SCHEMA);
    const first = renderEditor(MAPPED_SCHEMA);
    expect(screen.getByTestId('mock-field-editor')).toBeDefined();
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBeNull();
    first.unmount();
    renderEditor(MAPPED_SCHEMA);
    expect(screen.queryByTestId('mock-field-editor')).toBeNull();
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
  });

  test('the intent is inert on an unmapped schema (Fields unavailable → Source)', async () => {
    const { requestSchemaFieldsView } = await import('@/lib/schema-fields-view-intent');
    requestSchemaFieldsView(UNMAPPED_SCHEMA);
    renderEditor(UNMAPPED_SCHEMA);
    expect(screen.queryByTestId('mock-field-editor')).toBeNull();
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
  });

  test('an already-mounted editor switches to Fields when the intent arrives', async () => {
    const { requestSchemaFieldsView } = await import('@/lib/schema-fields-view-intent');
    renderEditor(MAPPED_SCHEMA);
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();

    await act(async () => {
      requestSchemaFieldsView(MAPPED_SCHEMA);
    });

    expect(screen.getByTestId('mock-field-editor').getAttribute('data-file')).toBe(MAPPED_SCHEMA);
    expect(screen.queryByTestId('mock-text-viewer')).toBeNull();
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBeNull();
  });

  test('an intent for another file leaves the mounted editor alone and stays claimable', async () => {
    const { requestSchemaFieldsView } = await import('@/lib/schema-fields-view-intent');
    renderEditor(MAPPED_SCHEMA);

    await act(async () => {
      requestSchemaFieldsView(OTHER_MAPPED_SCHEMA);
    });
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();

    cleanup();
    renderEditor(OTHER_MAPPED_SCHEMA);
    expect(screen.getByTestId('mock-field-editor').getAttribute('data-file')).toBe(
      OTHER_MAPPED_SCHEMA,
    );
  });

  test('a newer request supersedes an unclaimed one so it cannot ambush a later open', async () => {
    const { requestSchemaFieldsView } = await import('@/lib/schema-fields-view-intent');
    requestSchemaFieldsView(MAPPED_SCHEMA);
    requestSchemaFieldsView(OTHER_MAPPED_SCHEMA);

    renderEditor(MAPPED_SCHEMA);
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
    expect(screen.queryByTestId('mock-field-editor')).toBeNull();
  });

  test('unmount drops the live listener, so a later mount still claims the intent', async () => {
    const { requestSchemaFieldsView } = await import('@/lib/schema-fields-view-intent');
    renderEditor(MAPPED_SCHEMA).unmount();

    await act(async () => {
      requestSchemaFieldsView(MAPPED_SCHEMA);
    });

    renderEditor(MAPPED_SCHEMA);
    expect(screen.getByTestId('mock-field-editor').getAttribute('data-file')).toBe(MAPPED_SCHEMA);
    expect(screen.queryByTestId('mock-text-viewer')).toBeNull();
  });
});

describe('SchemaConfigEditor — mapped-file gating', () => {
  test('enables Fields for a mapped schema file', () => {
    renderEditor(MAPPED_SCHEMA);
    expect(fieldsSegment().disabled).toBe(false);
  });

  test('disables Fields for an unmapped schema, Source still works', () => {
    renderEditor(UNMAPPED_SCHEMA);
    expect(fieldsSegment().disabled).toBe(true);
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
  });

  test('the disabled Fields segment explains why via its description', () => {
    renderEditor(UNMAPPED_SCHEMA);
    const fields = fieldsSegment();
    const describedById = fields.getAttribute('aria-describedby');
    expect(describedById).not.toBeNull();
    expect(document.getElementById(describedById as string)?.textContent).toBe(
      'Field editing is available for schema files mapped in the Frontmatter schemas plugin',
    );
  });
});

describe('SchemaConfigEditor — switching and persistence', () => {
  test('switching to Fields mounts the field editor over the file and persists', async () => {
    const user = userEvent.setup();
    renderEditor(MAPPED_SCHEMA);

    await user.click(fieldsSegment());
    expect(screen.getByTestId('mock-field-editor').getAttribute('data-file')).toBe(MAPPED_SCHEMA);
    expect(screen.queryByTestId('mock-text-viewer')).toBeNull();
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('rules');

    await user.click(sourceSegment());
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
    expect(screen.queryByTestId('mock-field-editor')).toBeNull();
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('source');
  });

  test('a persisted Fields preference falls back to Source on an unmapped schema', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'rules');
    renderEditor(UNMAPPED_SCHEMA);

    expect(fieldsSegment().disabled).toBe(true);
    expect(screen.getByTestId('mock-text-viewer')).toBeDefined();
    expect(screen.queryByTestId('mock-field-editor')).toBeNull();
  });
});
