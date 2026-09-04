import { HocuspocusProvider } from '@hocuspocus/provider';
import type { LintDiagnostic, LinterConfig } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';

function missingDiagnostic(property: string): LintDiagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    severity: 'warning',
    source: 'frontmatter',
    code: 'required',
    message: `Frontmatter property "${property}" is required`,
    frontmatterScope: 'missing',
    frontmatterProperty: property,
  };
}

const SCHEMA = {
  type: 'object',
  required: ['status', 'tags'],
  properties: {
    status: { type: 'string', description: 'Lifecycle stage' },
    tags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

const ENUM_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: { status: { enum: ['draft', 'published'] } },
};

const DATE_SCHEMA = {
  type: 'object',
  required: ['publishedAt'],
  properties: { publishedAt: { type: 'string', format: 'date' } },
};

function configWithSchema(schema: Record<string, unknown> = SCHEMA): LinterConfig {
  return {
    enabled: true,
    plugins: {
      markdownlint: { enabled: false, rules: {} },
      frontmatter: {
        enabled: true,
        schemas: [{ appliesTo: '**', file: 'doc.json', schema }],
      },
    },
  };
}

let diagnostics: LintDiagnostic[] = [];
let lintConfig: LinterConfig | null = null;

vi.doMock('@/editor/useFrontmatterDiagnostics', async () => {
  const actual = await vi.importActual<typeof import('@/editor/useFrontmatterDiagnostics')>(
    '@/editor/useFrontmatterDiagnostics',
  );
  return { ...actual, useFrontmatterDiagnostics: () => diagnostics };
});

vi.doMock('@/editor/lint-config-client', async () => {
  const actual = await vi.importActual<typeof import('@/editor/lint-config-client')>(
    '@/editor/lint-config-client',
  );
  return { ...actual, useDocLintConfig: () => ({ data: { effective: lintConfig } }) };
});

const providers: HocuspocusProvider[] = [];

function makeProvider(docName: string): HocuspocusProvider {
  const p = new HocuspocusProvider({ url: 'ws://localhost:1/collab', name: docName });
  providers.push(p);
  return p;
}

function seedYTextFm(provider: HocuspocusProvider, fenced: string): void {
  const ytext = provider.document.getText('source');
  provider.document.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, fenced);
  });
}

function readSource(provider: HocuspocusProvider): string {
  return provider.document.getText('source').toString();
}

async function renderPanel(provider: HocuspocusProvider, reservedKeys?: readonly string[]) {
  const { PropertyProvider, useProperties } = await import('./PropertyContext');
  const { PropertyPanel } = await import('./PropertyPanel');
  const docName = provider.configuration.name ?? '';

  function ToolbarTrigger() {
    const { requestAddProperty } = useProperties();
    return (
      <Button data-testid="toolbar-add-properties" onClick={() => requestAddProperty(docName)}>
        add
      </Button>
    );
  }

  return render(
    <TooltipProvider>
      <PropertyProvider>
        <ToolbarTrigger />
        <PropertyPanel provider={provider} reservedKeys={reservedKeys} />
      </PropertyProvider>
    </TooltipProvider>,
  );
}

function addRows(): HTMLElement[] {
  return screen.queryAllByTestId('add-property-row');
}

function rowFor(name: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="add-property-row"][data-key="staged-${name}"]`,
  );
  if (!row) throw new Error(`no staged row for "${name}"`);
  return row;
}

function nameValueOf(row: HTMLElement): string {
  return within(row).getByTestId<HTMLInputElement>('add-property-name-input').value;
}

beforeEach(() => {
  diagnostics = [];
  lintConfig = configWithSchema();
});

afterEach(() => {
  cleanup();
  for (const p of providers.splice(0)) p.destroy();
});

describe('PropertyPanel — staging schema-required properties', () => {
  test('stages one pre-named row per missing property without touching the file', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-two');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n\nBody\n');
    const before = readSource(provider);
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(2));
    expect(nameValueOf(rowFor('status'))).toBe('status');
    expect(nameValueOf(rowFor('tags'))).toBe('tags');
    expect(readSource(provider)).toBe(before);
  });

  test('the staged row takes its widget type from the schema', async () => {
    diagnostics = [missingDiagnostic('tags')];
    const provider = makeProvider('staged-type');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    expect(within(rowFor('tags')).getByTestId('list-widget')).toBeTruthy();
  });

  test('a staged required date row opens empty, not committable with today', async () => {
    lintConfig = configWithSchema(DATE_SCHEMA);
    diagnostics = [missingDiagnostic('publishedAt')];
    const provider = makeProvider('staged-date-empty');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    const row = rowFor('publishedAt');
    expect(within(row).getByTestId('date-widget').querySelector('input')?.value).toBe('');
    expect(within(row).getByTestId<HTMLButtonElement>('add-property-commit').disabled).toBe(true);
  });

  test('filling one row writes only that property and leaves its siblings staged', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-commit-one');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(2));

    const row = rowFor('status');
    const valueInput = within(row).getByTestId('text-widget');
    await userEvent.click(valueInput);
    await userEvent.type(valueInput, 'draft');
    await userEvent.click(within(row).getByTestId('add-property-commit'));

    await waitFor(() => expect(readSource(provider)).toContain('status: draft'));
    expect(readSource(provider)).not.toContain('tags:');
    expect(addRows()).toHaveLength(1);
    expect(nameValueOf(rowFor('tags'))).toBe('tags');
  });

  test('a property the document already has is not staged', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-already-present');
    seedYTextFm(provider, '---\nstatus: draft\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    expect(nameValueOf(addRows()[0] as HTMLElement)).toBe('tags');
  });

  test('two schemas requiring the same property stage one row', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('status')];
    const provider = makeProvider('staged-dedup');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
  });

  test('a reserved property is never staged', async () => {
    lintConfig = configWithSchema({
      type: 'object',
      required: ['name', 'status'],
      properties: { name: { type: 'string' }, status: { type: 'string' } },
    });
    diagnostics = [missingDiagnostic('name'), missingDiagnostic('status')];
    const provider = makeProvider('staged-reserved');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider, ['name']);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    expect(nameValueOf(addRows()[0] as HTMLElement)).toBe('status');
    expect(document.querySelector('[data-key="staged-name"]')).toBeNull();
  });

  test('nothing missing still opens one blank row', async () => {
    diagnostics = [];
    const provider = makeProvider('staged-none-missing');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    expect(nameValueOf(addRows()[0] as HTMLElement)).toBe('');
  });

  test("the panel's own Add opens one blank row even when properties are missing", async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('inline-add-blank');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('add-property-trigger'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    const row = addRows()[0] as HTMLElement;
    expect(nameValueOf(row)).toBe('');
    expect(document.activeElement).toBe(within(row).getByTestId('add-property-name-input'));
  });

  test('a present-but-invalid property is not staged', async () => {
    diagnostics = [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        severity: 'warning',
        source: 'frontmatter',
        code: 'enum',
        message: 'Frontmatter property "status" must be one of: draft',
        frontmatterScope: 'invalid',
      },
    ];
    const provider = makeProvider('staged-invalid-only');
    seedYTextFm(provider, '---\nstatus: shipped\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    expect(nameValueOf(addRows()[0] as HTMLElement)).toBe('');
  });

  test('dismissing one staged row leaves the rest', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-dismiss-one');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(2));

    await userEvent.click(within(rowFor('status')).getByTestId('add-property-cancel'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    expect(nameValueOf(rowFor('tags'))).toBe('tags');
  });

  test('the first staged row starts in its value, not its name', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-focus');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(2));
    const first = rowFor('status');
    const active = document.activeElement;
    expect(first.contains(active)).toBe(true);
    expect(active).not.toBe(within(first).getByTestId('add-property-name-input'));
  });

  test('only the first staged row claims focus', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-focus-single');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(2));
    expect(rowFor('tags').contains(document.activeElement)).toBe(false);
  });

  test('picking a suggestion applies its type, and siblings stop offering it', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-pick-and-dedup');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(2));

    const row = rowFor('tags');
    const nameInput = within(row).getByTestId('add-property-name-input');
    await userEvent.clear(nameInput);
    await waitFor(() =>
      expect(screen.queryAllByTestId('add-property-field-suggestion').length).toBeGreaterThan(0),
    );

    const offered = screen
      .queryAllByTestId('add-property-field-suggestion')
      .map((el) => el.getAttribute('data-key'));
    expect(offered).not.toContain('status');
    expect(offered).toContain('tags');

    await userEvent.click(
      document.querySelector(
        '[data-testid="add-property-field-suggestion"][data-key="tags"]',
      ) as HTMLElement,
    );
    await waitFor(() =>
      expect((within(row).getByTestId('add-property-name-input') as HTMLInputElement).value).toBe(
        'tags',
      ),
    );
    expect(within(row).getByTestId('list-widget')).toBeTruthy();
  });

  test('a staged enum field offers its vocabulary instead of free text', async () => {
    lintConfig = configWithSchema(ENUM_SCHEMA);
    diagnostics = [missingDiagnostic('status')];
    const provider = makeProvider('staged-enum');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    const row = rowFor('status');
    expect(within(row).getByTestId('property-enum-select')).toBeTruthy();
    expect(within(row).queryByTestId('text-widget')).toBeNull();
  });

  test('a blank row still starts in its name field', async () => {
    diagnostics = [];
    const provider = makeProvider('staged-blank-focus');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    const row = addRows()[0] as HTMLElement;
    expect(document.activeElement).toBe(within(row).getByTestId('add-property-name-input'));
  });

  test('typing a name in a blank row does not move the caret to the value', async () => {
    diagnostics = [];
    const provider = makeProvider('staged-typing-keeps-focus');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(1));

    const row = addRows()[0] as HTMLElement;
    const nameInput = within(row).getByTestId<HTMLInputElement>('add-property-name-input');
    await userEvent.click(nameInput);
    await userEvent.type(nameInput, 'reviewer');

    expect(nameInput.value).toBe('reviewer');
    expect(document.activeElement).toBe(nameInput);
  });

  test('a staged row keeps focus where the user puts it after opening', async () => {
    diagnostics = [missingDiagnostic('status')];
    const provider = makeProvider('staged-focus-not-restolen');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(1));

    const nameInput = within(rowFor('status')).getByTestId<HTMLInputElement>(
      'add-property-name-input',
    );
    await userEvent.click(nameInput);
    await userEvent.type(nameInput, 'X');

    expect(document.activeElement).toBe(nameInput);
  });

  test('staged rows carry their own error target', async () => {
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-error-ids');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(2));

    for (const name of ['status', 'tags']) {
      const nameInput = within(rowFor(name)).getByTestId('add-property-name-input');
      await userEvent.click(nameInput);
      await userEvent.keyboard('{Enter}');
    }

    const errors = await screen.findAllByTestId('add-property-error');
    expect(errors).toHaveLength(2);
    const ids = errors.map((el) => el.getAttribute('id'));
    expect(ids.every((id) => id !== null && id !== '')).toBe(true);
    expect(new Set(ids).size).toBe(2);
    for (const name of ['status', 'tags']) {
      const row = rowFor(name);
      const describedBy = within(row)
        .getByTestId('add-property-name-input')
        .getAttribute('aria-describedby');
      expect(within(row).getByTestId('add-property-error').getAttribute('id')).toBe(describedBy);
    }
  });
});
