/**
 * DOM tests for nested-frontmatter CRUD via the binding's local path
 * API. Each test mounts a real {@link PropertyPanel} under a
 * {@link HocuspocusProvider}, exercises an interaction (edit / add /
 * rename / delete) on a nested key, then asserts the Y.Text-backed YAML
 * region reflects the change.
 *
 * Why this layer: the binding-side path API is covered by
 * `bind-frontmatter-doc.test.ts`; the panel-side renders are covered by
 * `PropertyPanel.test.tsx`. The seam between the two — the
 * {@link ObjectWidget} dispatcher wiring path-aware handlers to the
 * binding's `patchPath` / `renamePath` / `deletePath` — only fires under
 * a mounted React tree with effects. These tests pin that seam.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { readFmMap } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PropertyProvider } from './PropertyContext';
import { PropertyPanel } from './PropertyPanel';

const DUMMY_WS = 'ws://localhost:1/collab';

const providers: HocuspocusProvider[] = [];

function makeProvider(docName: string): HocuspocusProvider {
  const p = new HocuspocusProvider({ url: DUMMY_WS, name: docName });
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

function readPanelMap(provider: HocuspocusProvider): Record<string, unknown> {
  return readFmMap(provider.document.getText('source').toString()) as Record<string, unknown>;
}

function renderPanel(provider: HocuspocusProvider) {
  return render(
    <TooltipProvider>
      <PropertyProvider>
        <PropertyPanel provider={provider} />
      </PropertyProvider>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  for (const p of providers.splice(0)) {
    try {
      p.destroy();
    } catch {
      // ignore
    }
  }
});

describe('PropertyPanel — nested CRUD (US-007)', () => {
  async function findInputByKey(testid: string, key: string): Promise<HTMLElement> {
    // The test substrate mounts the panel; the binding attaches via useEffect.
    // `waitFor` polls until the row renders (no fixed budget — less flaky on
    // slow CI workers than a hand-rolled loop).
    return waitFor(() => {
      const el = document.querySelector(
        `[data-testid="${testid}"][data-key="${key}"]`,
      ) as HTMLElement | null;
      if (!el) throw new Error(`element not found: [data-testid="${testid}"][data-key="${key}"]`);
      return el;
    });
  }

  test('editing a nested scalar leaf commits via binding.patchPath and persists', async () => {
    const provider = makeProvider('nested-edit-leaf-doc');
    seedYTextFm(
      provider,
      '---\nname: skill\nmetadata:\n  version: "1.0.0"\n  author: Inkeep\n---\n',
    );
    renderPanel(provider);

    const versionInput = (await findInputByKey(
      'text-widget',
      'version',
    )) as HTMLTextAreaElement | null;
    expect(versionInput).not.toBeNull();
    if (!versionInput) return;

    const user = userEvent.setup();
    await user.click(versionInput);
    await user.clear(versionInput);
    await user.type(versionInput, '2.0.0');
    await user.tab(); // blur — commits the typed draft via the binding.

    const map = readPanelMap(provider);
    expect(map).toEqual({
      name: 'skill',
      metadata: { version: '2.0.0', author: 'Inkeep' },
    });
  });

  test('deleting a nested key removes ONLY that leaf and preserves siblings', async () => {
    const provider = makeProvider('nested-delete-leaf-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  version: "1.0.0"\n  author: Inkeep\n  license: MIT\n---\n',
    );
    renderPanel(provider);

    const versionRemove = document.querySelector(
      'button[data-testid="property-remove-button"][data-key="version"]',
    ) as HTMLButtonElement | null;
    expect(versionRemove).not.toBeNull();
    if (!versionRemove) return;

    const user = userEvent.setup();
    await user.click(versionRemove);

    const map = readPanelMap(provider);
    expect(map).toEqual({
      metadata: { author: 'Inkeep', license: 'MIT' },
    });
  });

  test('renaming a nested key uses binding.renamePath (preserves source position)', async () => {
    const provider = makeProvider('nested-rename-leaf-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  version: "1.0.0"\n  author: Inkeep\n  license: MIT\n---\n',
    );
    renderPanel(provider);

    const authorNameButton = document.querySelector(
      'button[data-testid="property-name-button"][data-key="author"]',
    ) as HTMLButtonElement | null;
    expect(authorNameButton).not.toBeNull();
    if (!authorNameButton) return;

    const user = userEvent.setup();
    await user.click(authorNameButton);

    const renameInput = await screen.findByTestId('property-name-rename-input');
    // The rename input only mounts for the row in rename mode — assert it's
    // bound to author specifically.
    expect(renameInput.getAttribute('data-key')).toBe('author');

    await user.clear(renameInput);
    await user.type(renameInput, 'maintainer');
    await user.keyboard('{Enter}');

    const map = readPanelMap(provider);
    expect(map).toEqual({
      metadata: { version: '1.0.0', maintainer: 'Inkeep', license: 'MIT' },
    });
    // Source-position is preserved: serialize order should be version,
    // maintainer (renamed-in-place), license.
    const fenced = provider.document.getText('source').toString();
    const versionIdx = fenced.indexOf('version:');
    const maintainerIdx = fenced.indexOf('maintainer:');
    const licenseIdx = fenced.indexOf('license:');
    expect(versionIdx).toBeLessThan(maintainerIdx);
    expect(maintainerIdx).toBeLessThan(licenseIdx);
  });

  test('adding a nested key uses binding.patchPath (preserves siblings)', async () => {
    const provider = makeProvider('nested-add-leaf-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0.0"\n  author: Inkeep\n---\n');
    renderPanel(provider);

    const addTrigger = document.querySelector(
      'button[data-testid="object-widget-add-trigger"][data-key="metadata"]',
    ) as HTMLButtonElement | null;
    expect(addTrigger).not.toBeNull();
    if (!addTrigger) return;

    const user = userEvent.setup();
    await user.click(addTrigger);

    const nameInput = await screen.findByTestId('add-property-name-input');
    await user.type(nameInput, 'license');
    // The default type is 'text' — value widget already has draft.value=''.
    // We need to type a value so the commit gate (isFrontmatterValueEmpty)
    // admits the add. The value widget for a text type is a textarea with
    // data-testid="text-widget" + data-key="__add__".
    const addValueInput = document.querySelector(
      'textarea[data-testid="text-widget"][data-key="__add__"]',
    ) as HTMLTextAreaElement | null;
    expect(addValueInput).not.toBeNull();
    if (!addValueInput) return;
    await user.click(addValueInput);
    await user.type(addValueInput, 'MIT');
    // Commit via the explicit "Add" button (Enter on the value's textarea
    // would commit the value draft, not the add row).
    const addCommit = await screen.findByTestId('add-property-commit');
    await user.click(addCommit);

    const map = readPanelMap(provider);
    expect(map).toEqual({
      metadata: { version: '1.0.0', author: 'Inkeep', license: 'MIT' },
    });
  });

  test('adding a duplicate nested key surfaces an inline error and does not commit', async () => {
    const provider = makeProvider('nested-add-dup-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0.0"\n---\n');
    renderPanel(provider);

    const addTrigger = document.querySelector(
      'button[data-testid="object-widget-add-trigger"][data-key="metadata"]',
    ) as HTMLButtonElement | null;
    expect(addTrigger).not.toBeNull();
    if (!addTrigger) return;

    const user = userEvent.setup();
    await user.click(addTrigger);

    const nameInput = await screen.findByTestId('add-property-name-input');
    await user.type(nameInput, 'version');
    // The "Add" commit gate disables the button when the value is empty
    // (matches mergePatch drop-on-empty). Type a value so the click fires
    // and the duplicate-key check actually runs.
    const valueInput = document.querySelector(
      'textarea[data-testid="text-widget"][data-key="__add__"]',
    ) as HTMLTextAreaElement | null;
    expect(valueInput).not.toBeNull();
    if (!valueInput) return;
    await user.click(valueInput);
    await user.type(valueInput, 'whatever');
    const addCommit = await screen.findByTestId('add-property-commit');
    await user.click(addCommit);

    const errorEl = await screen.findByTestId('add-property-error');
    expect(errorEl.textContent ?? '').toContain('version');
    // No mutation — the original FM is unchanged.
    expect(readPanelMap(provider)).toEqual({ metadata: { version: '1.0.0' } });
  });

  test('editing a deeply nested leaf (depth 2) commits via the path API', async () => {
    const provider = makeProvider('nested-edit-depth2-doc');
    seedYTextFm(provider, '---\nouter:\n  inner:\n    leaf: "old"\n    other: keep\n---\n');
    renderPanel(provider);

    // Radix CollapsibleContent unmounts its content while closed. The
    // depth-1 ObjectWidget (`inner`) auto-collapses on mount, so the
    // depth-2 `leaf` row is NOT in the DOM until the user expands.
    const innerTrigger = (await findInputByKey(
      'object-widget-trigger',
      'inner',
    )) as HTMLButtonElement | null;
    expect(innerTrigger).not.toBeNull();
    if (!innerTrigger) return;
    const user = userEvent.setup();
    await user.click(innerTrigger);

    const targetLeaf = (await findInputByKey('text-widget', 'leaf')) as HTMLTextAreaElement | null;
    expect(targetLeaf).not.toBeNull();
    if (!targetLeaf) return;

    await user.click(targetLeaf);
    await user.clear(targetLeaf);
    await user.type(targetLeaf, 'new');
    await user.tab();

    const map = readPanelMap(provider);
    expect(map).toEqual({
      outer: { inner: { leaf: 'new', other: 'keep' } },
    });
  });

  test('nested rename to an existing sibling shows duplicate-name error and does not mutate', async () => {
    const provider = makeProvider('nested-rename-dup-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0.0"\n  author: Inkeep\n---\n');
    renderPanel(provider);

    const versionNameButton = document.querySelector(
      'button[data-testid="property-name-button"][data-key="version"]',
    ) as HTMLButtonElement | null;
    expect(versionNameButton).not.toBeNull();
    if (!versionNameButton) return;

    const user = userEvent.setup();
    await user.click(versionNameButton);

    const renameInput = await screen.findByTestId('property-name-rename-input');
    await user.clear(renameInput);
    await user.type(renameInput, 'author');
    await user.keyboard('{Enter}');

    // Inline error surfaces; Y.Text unchanged.
    const errorEl = await screen.findByTestId('property-name-rename-error');
    expect(errorEl.textContent ?? '').toContain('author');
    const map = readPanelMap(provider);
    expect(map).toEqual({
      metadata: { version: '1.0.0', author: 'Inkeep' },
    });
  });
});

describe('PropertyPanel — array-of-objects CRUD (US-008)', () => {
  async function findAddItemTrigger(arrayKey: string): Promise<HTMLButtonElement | null> {
    for (let i = 0; i < 20; i++) {
      const el = document.querySelector(
        `button[data-testid="array-of-objects-widget-add-trigger"][data-key="${arrayKey}"]`,
      ) as HTMLButtonElement | null;
      if (el) return el;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  test('adding an item appends an empty object at end via binding.patchPath', async () => {
    const provider = makeProvider('aoo-add-doc');
    seedYTextFm(provider, '---\nauthors:\n  - name: A\n  - name: B\n---\n');
    renderPanel(provider);

    const addTrigger = await findAddItemTrigger('authors');
    expect(addTrigger).not.toBeNull();
    if (!addTrigger) return;
    const user = userEvent.setup();
    await user.click(addTrigger);

    const map = readPanelMap(provider);
    expect(map).toEqual({ authors: [{ name: 'A' }, { name: 'B' }, {}] });
  });

  test('removing an item splices the sequence and renumbers remaining indices', async () => {
    const provider = makeProvider('aoo-remove-doc');
    seedYTextFm(provider, '---\nauthors:\n  - name: A\n  - name: B\n  - name: C\n---\n');
    renderPanel(provider);

    let removeBtn: HTMLButtonElement | null = null;
    for (let i = 0; i < 20; i++) {
      removeBtn = document.querySelector(
        'button[data-testid="array-item-remove"][data-key="authors"][data-index="0"]',
      ) as HTMLButtonElement | null;
      if (removeBtn) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(removeBtn).not.toBeNull();
    if (!removeBtn) return;

    const user = userEvent.setup();
    await user.click(removeBtn);

    const map = readPanelMap(provider);
    expect(map).toEqual({ authors: [{ name: 'B' }, { name: 'C' }] });
  });

  test('removing the last item drops the property (no bare-[] scalar-list dead-end)', async () => {
    const provider = makeProvider('aoo-last-remove-doc');
    seedYTextFm(provider, '---\nauthors:\n  - name: Solo\n---\n');
    renderPanel(provider);

    let removeBtn: HTMLButtonElement | null = null;
    for (let i = 0; i < 20; i++) {
      removeBtn = document.querySelector(
        'button[data-testid="array-item-remove"][data-key="authors"][data-index="0"]',
      ) as HTMLButtonElement | null;
      if (removeBtn) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(removeBtn).not.toBeNull();
    if (!removeBtn) return;

    const user = userEvent.setup();
    await user.click(removeBtn);

    // The whole `authors` key is removed rather than left as a bare `[]`, which
    // would re-dispatch to the scalar chip widget with no way to re-add objects.
    const map = readPanelMap(provider);
    expect(map.authors).toBeUndefined();
  });

  test('a successful item delete leaves no array-item-error markers', async () => {
    const provider = makeProvider('aoo-error-clear-doc');
    seedYTextFm(provider, '---\nauthors:\n  - name: A\n  - name: B\n---\n');
    renderPanel(provider);

    let removeBtn: HTMLButtonElement | null = null;
    for (let i = 0; i < 20; i++) {
      removeBtn = document.querySelector(
        'button[data-testid="array-item-remove"][data-key="authors"][data-index="0"]',
      ) as HTMLButtonElement | null;
      if (removeBtn) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!removeBtn) return;
    const user = userEvent.setup();
    await user.click(removeBtn);

    expect(document.querySelectorAll('[data-testid="array-item-error"]').length).toBe(0);
  });

  test('editing a field within an item commits at item-index path', async () => {
    const provider = makeProvider('aoo-edit-doc');
    seedYTextFm(provider, '---\nauthors:\n  - name: A\n  - name: B\n---\n');
    renderPanel(provider);

    let nameInput: HTMLTextAreaElement | null = null;
    for (let i = 0; i < 20; i++) {
      const inputs = document.querySelectorAll(
        'textarea[data-testid="text-widget"][data-key="name"]',
      );
      if (inputs.length >= 2) {
        nameInput = inputs[1] as HTMLTextAreaElement;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(nameInput).not.toBeNull();
    if (!nameInput) return;

    const user = userEvent.setup();
    await user.click(nameInput);
    await user.clear(nameInput);
    await user.type(nameInput, 'Bee');
    await user.tab();

    const map = readPanelMap(provider);
    expect(map).toEqual({ authors: [{ name: 'A' }, { name: 'Bee' }] });
  });

  test('scalar arrays still render via the chip ListWidget (no regression)', async () => {
    const provider = makeProvider('aoo-scalar-regression-doc');
    seedYTextFm(provider, '---\ntags:\n  - alpha\n  - beta\n---\n');
    renderPanel(provider);

    let listWidget: HTMLElement | null = null;
    for (let i = 0; i < 20; i++) {
      listWidget = document.querySelector(
        '[data-testid="list-widget"][data-key="tags"]',
      ) as HTMLElement | null;
      if (listWidget) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(listWidget).not.toBeNull();
    expect(
      document.querySelector('[data-testid="array-of-objects-widget"][data-key="tags"]'),
    ).toBeNull();
  });
});
