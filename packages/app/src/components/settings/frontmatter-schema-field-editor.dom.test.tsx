/**
 * DOM tests for the per-field schema editor: rows render from the resolved
 * schema in the effective lint config, edits persist one field-constraint at
 * a time through the write client, and fields carrying unmodeled keywords are
 * flagged as preserved.
 */

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

let mockLintData: unknown = null;
const writes: [string, string, unknown, unknown[]][] = [];
const removes: [string, string, unknown[]][] = [];
const renames: [string, string, string, unknown[]][] = [];
vi.doMock('@/editor/lint-config-client', () => ({
  emitLintConfigChanged: () => {},
  subscribeToLintConfigChanged: () => () => {},
  runLintAudit: async () => null,
  useDocLintConfig: () => ({ data: null }),
  useProjectLintConfig: () => ({ data: mockLintData }),
  fetchEffectiveLintConfig: async () => null,
  writeMarkdownlintRule: async () => ({ ok: false, errorDetail: null }),
  writeFrontmatterSchemaField: async (
    file: string,
    field: string,
    constraint: unknown,
    parentPath: unknown[] = [],
  ) => {
    writes.push([file, field, constraint, parentPath]);
    return { ok: true, response: null };
  },
  removeFrontmatterSchemaField: async (file: string, field: string, parentPath: unknown[] = []) => {
    removes.push([file, field, parentPath]);
    return { ok: true };
  },
  renameFrontmatterSchemaField: async (
    file: string,
    field: string,
    to: string,
    parentPath: unknown[] = [],
  ) => {
    renames.push([file, field, to, parentPath]);
    return { ok: true };
  },
}));

const { FrontmatterSchemaFieldEditor } = await import('./frontmatter-schema-field-editor.tsx');

const FILE = '.ok/schemas/doc.schema.json';

function lintDataWithSchema(schema: Record<string, unknown> | undefined) {
  return {
    effective: {
      enabled: true,
      plugins: {
        markdownlint: { enabled: false, rules: {} },
        frontmatter: {
          enabled: true,
          schemas: [{ appliesTo: 'docs/**', file: FILE, key: 'K', schema }],
        },
      },
    },
    configProblems: [],
  };
}

beforeEach(() => {
  cleanup();
  writes.length = 0;
  removes.length = 0;
  renames.length = 0;
  mockLintData = lintDataWithSchema({
    type: 'object',
    required: ['status'],
    properties: {
      status: { enum: ['draft', 'review'] },
      tags: { type: 'array', items: { enum: ['a', 'b'] } },
      custom: { type: 'string', minLength: 3 },
    },
  });
});

describe('FrontmatterSchemaFieldEditor', () => {
  test('renders a row per property with required state and enum pills', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    expect(screen.getByTestId('frontmatter-field-row-status')).toBeTruthy();
    const requiredSwitch = screen.getByTestId(
      'frontmatter-field-required-status',
    ) as HTMLButtonElement;
    expect(requiredSwitch.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
  });

  test('toggling required writes exactly that constraint', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    fireEvent.click(screen.getByTestId('frontmatter-field-required-status'));
    expect(writes).toEqual([[FILE, 'status', { required: false }, []]]);
  });

  test('array fields edit items.enum, not enum', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const row = within(screen.getByTestId('frontmatter-field-row-tags'));
    expect(row.getByText('Allowed element values (empty = any)')).toBeTruthy();
    expect(row.queryByText('Allowed values (empty = any)')).toBeNull();
    expect(row.getByText('a')).toBeTruthy();
  });

  test('a field with unmodeled keywords is flagged as preserved', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    expect(screen.getByTestId('frontmatter-field-preserved-custom')).toBeTruthy();
    expect(screen.queryByTestId('frontmatter-field-preserved-status')).toBeNull();
  });

  test('root-level advanced keywords surface a note naming them; absent otherwise', () => {
    // Raw JSON text, not an object literal: `then` is a JSON Schema
    // conditional here and a literal carrying it trips the thenable lint.
    mockLintData = lintDataWithSchema(
      JSON.parse(
        '{"type":"object","additionalProperties":false,"if":{"properties":{"a":{"const":"x"}}},"then":{"required":["b"]},"properties":{"a":{"type":"string"}}}',
      ),
    );
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const note = screen.getByTestId(`frontmatter-schema-root-preserved-${FILE}`);
    expect(note.textContent).toContain('additionalProperties');
    expect(note.textContent).toContain('if');
    cleanup();

    // The default beforeEach schema has only modeled root keys — no note.
    mockLintData = lintDataWithSchema({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    expect(screen.queryByTestId(`frontmatter-schema-root-preserved-${FILE}`)).toBeNull();
  });

  test('add field writes a string-typed constraint and works without a loaded schema', () => {
    mockLintData = lintDataWithSchema(undefined);
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    fireEvent.change(screen.getByTestId(`frontmatter-add-field-${FILE}-input`), {
      target: { value: 'owner' },
    });
    fireEvent.click(screen.getByTestId(`frontmatter-add-field-${FILE}-save`));
    expect(writes).toEqual([[FILE, 'owner', { type: 'string' }, []]]);
  });

  test('the remove button drops exactly that field', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    fireEvent.click(screen.getByTestId('frontmatter-field-remove-status'));
    expect(removes).toEqual([[FILE, 'status', []]]);
    expect(writes).toEqual([]);
  });

  test('committing an edited field name issues a rename', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const name = screen.getByTestId('frontmatter-field-name-status') as HTMLInputElement;
    expect(name.value).toBe('status');
    fireEvent.change(name, { target: { value: 'state' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(renames).toEqual([[FILE, 'status', 'state', []]]);
  });

  test('an unchanged or empty name commit does not rename', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const name = screen.getByTestId('frontmatter-field-name-status') as HTMLInputElement;
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.change(name, { target: { value: '  ' } });
    fireEvent.blur(name);
    expect(renames).toEqual([]);
  });

  test('committing a description writes that constraint; clearing removes it', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const description = screen.getByTestId(
      'frontmatter-field-description-status',
    ) as HTMLInputElement;
    fireEvent.change(description, { target: { value: 'Lifecycle state' } });
    fireEvent.keyDown(description, { key: 'Enter' });
    expect(writes).toEqual([[FILE, 'status', { description: 'Lifecycle state' }, []]]);
  });

  test('a field with enum values presents as the enum pseudo-type', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const row = within(screen.getByTestId('frontmatter-field-row-status'));
    expect(row.getByTestId('frontmatter-field-type-status').textContent).toContain('enum');
  });

  test('object fields render nested child rows; nested edits carry the parent path', () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          required: ['owner'],
          properties: { owner: { type: 'string' } },
        },
      },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);

    const nestedRow = screen.getByTestId('frontmatter-field-row-meta.owner');
    expect(nestedRow).toBeTruthy();
    const requiredSwitch = screen.getByTestId(
      'frontmatter-field-required-meta.owner',
    ) as HTMLButtonElement;
    expect(requiredSwitch.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(requiredSwitch);
    expect(writes).toEqual([[FILE, 'owner', { required: false }, ['meta']]]);

    fireEvent.click(screen.getByTestId('frontmatter-field-remove-meta.owner'));
    expect(removes).toEqual([[FILE, 'owner', ['meta']]]);
  });

  test('adding a field inside an object row targets that parent', () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: { meta: { type: 'object' } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);

    const children = within(screen.getByTestId('frontmatter-field-children-meta'));
    fireEvent.change(children.getByTestId('frontmatter-add-field-meta-input'), {
      target: { value: 'owner' },
    });
    fireEvent.click(children.getByTestId('frontmatter-add-field-meta-save'));
    expect(writes).toEqual([[FILE, 'owner', { type: 'string' }, ['meta']]]);
  });

  test('array rows show an element-type select; enum elements present as enum', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    // `tags` has items.enum values → the element-type select presents `enum`.
    const itemsSelect = screen.getByTestId('frontmatter-field-items-type-tags');
    expect(itemsSelect.textContent).toContain('enum');
  });

  test('array-of-object rows render element fields; nested ops carry the items segment', () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: {
        ingredients: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);

    // The element sub-schema renders as rows under the `[]` path marker.
    const row = screen.getByTestId('frontmatter-field-row-ingredients.[].name');
    expect(row).toBeTruthy();
    // No element-values pills for object elements.
    expect(screen.queryByTestId('frontmatter-field-items-enum-ingredients')).toBeNull();

    fireEvent.click(screen.getByTestId('frontmatter-field-required-ingredients.[].name'));
    expect(writes).toEqual([[FILE, 'name', { required: false }, ['ingredients', { items: true }]]]);

    const children = within(screen.getByTestId('frontmatter-field-item-children-ingredients'));
    fireEvent.change(children.getByTestId('frontmatter-add-field-ingredients.[]-input'), {
      target: { value: 'quantity' },
    });
    fireEvent.click(children.getByTestId('frontmatter-add-field-ingredients.[]-save'));
    expect(writes[1]).toEqual([
      FILE,
      'quantity',
      { type: 'string' },
      ['ingredients', { items: true }],
    ]);
  });
});
