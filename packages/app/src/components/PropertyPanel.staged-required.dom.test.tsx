/**
 * Acting on the toolbar's Add-properties button lands here: one pre-named
 * add-row per schema-required property the document lacks, so the user fills in
 * values instead of retyping names the schema already states.
 *
 * The load-bearing half is what does NOT happen. Staging writes nothing — a row
 * reaches the file only once it carries a value. Seeding empty placeholders
 * instead would put `status: ""` in the document and clear the very `required`
 * warning that produced the row, reporting the problem fixed while the field
 * is blank.
 */

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

/** Same shape, with `status` given a fixed vocabulary. */
const ENUM_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: { status: { enum: ['draft', 'published'] } },
};

/** A required `date`-format field — the widget type a staged row drafts as `date`. */
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

/**
 * Mounts the panel beside the toolbar's dispatcher, so a batch add arrives the
 * way it does in the app — the cross-tree signal. The panel renders its own
 * inline "Add" button, so both entry points are reachable from one render.
 */
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
    // The whole point: a staged row is a draft, not a write.
    expect(readSource(provider)).toBe(before);
  });

  test('the staged row takes its widget type from the schema', async () => {
    diagnostics = [missingDiagnostic('tags')];
    const provider = makeProvider('staged-type');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    // `tags` is declared `array`, so it drafts as a chip list rather than the
    // text box a type-blind stage would produce.
    expect(within(rowFor('tags')).getByTestId('list-widget')).toBeTruthy();
  });

  test('a staged required date row opens empty, not committable with today', async () => {
    // A date field seeded with today's date is committable without the user
    // choosing anything: one Add click writes a plausible-but-unchosen date and
    // clears the required warning that produced the row. It must open empty so
    // the commit gate stays shut until the user picks the real date — the same
    // block text/list rows already get from their empty defaults.
    lintConfig = configWithSchema(DATE_SCHEMA);
    diagnostics = [missingDiagnostic('publishedAt')];
    const provider = makeProvider('staged-date-empty');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    const row = rowFor('publishedAt');
    // The date input opens with no value…
    expect(within(row).getByTestId('date-widget').querySelector('input')?.value).toBe('');
    // …so the Add button stays disabled until a date is chosen.
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
    // `tags` was never filled, so it must not have been written alongside.
    expect(readSource(provider)).not.toContain('tags:');
    expect(addRows()).toHaveLength(1);
    expect(nameValueOf(rowFor('tags'))).toBe('tags');
  });

  test('a property the document already has is not staged', async () => {
    // The count is rendered from a debounced pass, so the doc can gain the
    // property between the badge and the click. Re-staging it would offer to
    // add a property that is already there and fail on commit.
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
    // The skill panel reserves `name` as the skill's folder identity — renamed
    // by moving the folder, never patched — so a schema that requires `name`
    // must not stage a row that would add it as a plain property.
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
    // Only `status` stages; `name` is reserved and gets no row.
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
    // Batch staging is the toolbar button's affordance. This control's object
    // is a single property — its label says "Add property", singular — so a
    // user reaching for it wants a row to name, not the schema's backlog. It
    // must stay singular however many required properties the doc lacks.
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('inline-add-blank');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('add-property-trigger'));

    await waitFor(() => expect(addRows()).toHaveLength(1));
    const row = addRows()[0] as HTMLElement;
    expect(nameValueOf(row)).toBe('');
    // A blank row has nothing to fill in yet, so it opens in its name field.
    expect(document.activeElement).toBe(within(row).getByTestId('add-property-name-input'));
  });

  test('a present-but-invalid property is not staged', async () => {
    // Only absent properties are this affordance's business; a wrong value has
    // a row of its own to correct.
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
    // "Add it and send me to edit it": the name is already filled in, so the
    // value is the only thing left to type.
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
    // `autoFocus` is last-one-wins: without the per-row gate the caret would
    // land on the bottom row of the batch.
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-focus-single');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);

    await userEvent.click(screen.getByTestId('toolbar-add-properties'));

    await waitFor(() => expect(addRows()).toHaveLength(2));
    expect(rowFor('tags').contains(document.activeElement)).toBe(false);
  });

  test('picking a suggestion applies its type, and siblings stop offering it', async () => {
    // Two mechanisms meet here and are only covered in isolation elsewhere:
    // `pickAddField` applies name + type + value as one update (so the widget
    // changes), and `suggestionsFor` withholds a name a sibling row already
    // claims (so a batch can't point two rows at one property).
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-pick-and-dedup');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(2));

    // Clear the `tags` row's name so its picker opens (an exact-match name
    // closes the list — there is nothing left to choose).
    const row = rowFor('tags');
    const nameInput = within(row).getByTestId('add-property-name-input');
    await userEvent.clear(nameInput);
    // The popup portals to document.body, so it is queried at screen level —
    // only the focused row's list is open at a time.
    await waitFor(() =>
      expect(screen.queryAllByTestId('add-property-field-suggestion').length).toBeGreaterThan(0),
    );

    // `status` is claimed by the sibling staged row, so this row must not offer
    // it — otherwise a batch could point two rows at one property.
    const offered = screen
      .queryAllByTestId('add-property-field-suggestion')
      .map((el) => el.getAttribute('data-key'));
    expect(offered).not.toContain('status');
    expect(offered).toContain('tags');

    // Picking `tags` (declared `array`) swaps the widget to the chip list — the
    // schema's type rides along with the name, in one update.
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
    // The row exists because a schema demands the property; handing the user a
    // free-text box for a fixed vocabulary invites the next violation.
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
    // The focus target describes where a row OPENS. Re-deriving it from the
    // live draft made the blank row want its name at `''` and its value at
    // `'a'`, so the first keystroke re-fired the focus effect and every
    // character after it went into the value widget instead.
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

    // The row opened in its value; moving to the name and typing must stick.
    const nameInput = within(rowFor('status')).getByTestId<HTMLInputElement>(
      'add-property-name-input',
    );
    await userEvent.click(nameInput);
    await userEvent.type(nameInput, 'X');

    expect(document.activeElement).toBe(nameInput);
  });

  test('staged rows carry their own error target', async () => {
    // One hardcoded id across sibling rows would point every row's
    // `aria-describedby` at the same node.
    diagnostics = [missingDiagnostic('status'), missingDiagnostic('tags')];
    const provider = makeProvider('staged-error-ids');
    seedYTextFm(provider, '---\ntitle: Doc\n---\n');
    await renderPanel(provider);
    await userEvent.click(screen.getByTestId('toolbar-add-properties'));
    await waitFor(() => expect(addRows()).toHaveLength(2));

    // Enter in the name field commits past the Add button's disabled state, so
    // both rows raise their own "Value is required".
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
    // And each row points at its own.
    for (const name of ['status', 'tags']) {
      const row = rowFor(name);
      const describedBy = within(row)
        .getByTestId('add-property-name-input')
        .getAttribute('aria-describedby');
      expect(within(row).getByTestId('add-property-error').getAttribute('id')).toBe(describedBy);
    }
  });
});
