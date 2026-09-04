import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const ElementProto = Element.prototype as Element & {
  hasPointerCapture?: () => boolean;
  releasePointerCapture?: () => void;
  scrollIntoView?: () => void;
};
ElementProto.hasPointerCapture ??= () => false;
ElementProto.releasePointerCapture ??= () => {};
ElementProto.scrollIntoView ??= () => {};

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

  test('an untyped field with enum values presents as the enum pseudo-type', () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const row = within(screen.getByTestId('frontmatter-field-row-status'));
    expect(row.getByTestId('frontmatter-field-type-status').textContent).toContain('enum');
  });

  test('entering an allowed value on a typed field writes only that constraint', () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: { owner: { type: 'string' } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const row = within(screen.getByTestId('frontmatter-field-row-owner'));
    const input = row.getByLabelText('Allowed values (empty = any)');
    fireEvent.change(input, { target: { value: 'ana' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(writes).toEqual([[FILE, 'owner', { enum: ['ana'] }, []]]);
  });

  test('a typed field carrying allowed values keeps presenting as its declared type', () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: {
        owner: { type: 'string', enum: ['ana', 'bo'] },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const type = screen.getByTestId('frontmatter-field-type-owner');
    expect(type.textContent).toContain('string');
    expect(type.textContent).not.toContain('enum');
    expect(screen.getByText('ana')).toBeTruthy();

    const itemsType = screen.getByTestId('frontmatter-field-items-type-tags');
    expect(itemsType.textContent).toContain('string');
    expect(itemsType.textContent).not.toContain('enum');
    expect(screen.getByText('a')).toBeTruthy();
  });

  test('picking the enum pseudo-type presents it without writing a type', async () => {
    mockLintData = lintDataWithSchema({ type: 'object', properties: { owner: {} } });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const type = screen.getByTestId('frontmatter-field-type-owner');
    await userEvent.click(type);
    await userEvent.click(await screen.findByRole('option', { name: 'enum' }));
    expect(writes).toEqual([]);
    expect(type.textContent).toContain('enum');
  });

  test('picking the enum pseudo-type on a typed field presents it without writing', async () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: { owner: { type: 'string' } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const type = screen.getByTestId('frontmatter-field-type-owner');
    expect(type.textContent).toContain('string');
    await userEvent.click(type);
    await userEvent.click(await screen.findByRole('option', { name: 'enum' }));
    expect(writes).toEqual([]);
    expect(type.textContent).toContain('enum');
  });

  test('picking a scalar after enum drops the intent, not just the values', async () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: { owner: { type: 'string', enum: ['a'] } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const type = screen.getByTestId('frontmatter-field-type-owner');
    await userEvent.click(type);
    await userEvent.click(await screen.findByRole('option', { name: 'enum' }));
    expect(type.textContent).toContain('enum');

    await userEvent.click(type);
    await userEvent.click(await screen.findByRole('option', { name: 'number' }));
    expect(writes).toEqual([[FILE, 'owner', { type: 'number', enum: null }, []]]);
    expect(type.textContent).not.toContain('enum');
    expect(type.textContent).toContain('string');
  });

  test('picking a scalar element type after enum drops the items intent', async () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string', enum: ['a'] } } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const itemsType = screen.getByTestId('frontmatter-field-items-type-tags');
    await userEvent.click(itemsType);
    await userEvent.click(await screen.findByRole('option', { name: 'enum' }));
    expect(itemsType.textContent).toContain('enum');

    await userEvent.click(itemsType);
    await userEvent.click(await screen.findByRole('option', { name: 'number' }));
    expect(writes).toEqual([[FILE, 'tags', { itemsType: 'number', itemsEnum: null }, []]]);
    expect(itemsType.textContent).not.toContain('enum');
    expect(itemsType.textContent).toContain('string');
  });

  test('leaving the enum presentation for a scalar type keeps the allowed values', async () => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    await userEvent.click(screen.getByTestId('frontmatter-field-type-status'));
    await userEvent.click(await screen.findByRole('option', { name: 'string' }));
    expect(writes).toEqual([[FILE, 'status', { type: 'string' }, []]]);
  });

  test.each([
    'number',
    'boolean',
    'array',
    'object',
  ])('switching to %s clears values that type could never satisfy', async (target) => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    await userEvent.click(screen.getByTestId('frontmatter-field-type-status'));
    await userEvent.click(await screen.findByRole('option', { name: target }));
    expect(writes).toEqual([[FILE, 'status', { type: target, enum: null }, []]]);
  });

  test.each([
    'number',
    'boolean',
    'object',
  ])('switching the element type to %s clears the element values', async (target) => {
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    await userEvent.click(screen.getByTestId('frontmatter-field-items-type-tags'));
    await userEvent.click(await screen.findByRole('option', { name: target }));
    expect(writes).toEqual([[FILE, 'tags', { itemsType: target, itemsEnum: null }, []]]);
  });

  test('entering an allowed element value on a typed array writes only that constraint', () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const row = within(screen.getByTestId('frontmatter-field-row-tags'));
    const input = row.getByLabelText('Allowed element values (empty = any)');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(writes).toEqual([[FILE, 'tags', { itemsEnum: ['a'] }, []]]);
  });

  test('picking the enum element type presents it without writing a type', async () => {
    mockLintData = lintDataWithSchema({
      type: 'object',
      properties: { tags: { type: 'array', items: {} } },
    });
    render(<FrontmatterSchemaFieldEditor file={FILE} />);
    const itemsType = screen.getByTestId('frontmatter-field-items-type-tags');
    await userEvent.click(itemsType);
    await userEvent.click(await screen.findByRole('option', { name: 'enum' }));
    expect(writes).toEqual([]);
    expect(itemsType.textContent).toContain('enum');
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

    const row = screen.getByTestId('frontmatter-field-row-ingredients.[].name');
    expect(row).toBeTruthy();
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
