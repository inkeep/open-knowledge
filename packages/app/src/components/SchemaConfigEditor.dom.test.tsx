/**
 * DOM tests for the schema-config editor pane: the Source/Fields toggle, its
 * mapped-file gating (Fields is offered only for schemas a live frontmatter
 * mapping references), and the mount discipline that lets the Source view
 * reflect a Fields edit.
 *
 * The system boundaries are mocked: the effective-config lookup
 * (`useProjectLintConfig`), the read-only source viewer (`TextViewer`), and
 * the per-field editor (`FrontmatterSchemaFieldEditor`). The toggle, its
 * gating logic, and the active-segment mount decision are the real code
 * under test.
 */

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
const MAPPED_SCHEMA = '.ok/schemas/doc.schema.json';
const UNMAPPED_SCHEMA = '.ok/schemas/orphan.schema.json';

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

beforeEach(() => {
  localStorage.clear();
  mockMappedFiles = [MAPPED_SCHEMA];
});

afterEach(() => {
  cleanup();
});

describe('SchemaConfigEditor — toggle and default view', () => {
  test('renders a Source/Fields toggle and defaults to the Source view', () => {
    renderEditor(MAPPED_SCHEMA);

    expect(fieldsSegment()).toBeDefined();
    expect(sourceSegment()).toBeDefined();
    // The feature-beta tag marks the schema editor surface.
    expect(screen.getByText('Beta')).toBeDefined();

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
    // The intent overrides the initial view only — the persisted preference
    // (default source) is untouched, so the next plain open is Source again.
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
