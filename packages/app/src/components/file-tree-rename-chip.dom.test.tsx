/**
 * DOM test for the rename-input affordance.
 *
 * Mounting the full FileTree exceeds the budget, so we construct a
 * Pierre-shaped rename-row DOM by hand and exercise
 * `applyRenameInputAffordance` directly. Covers the inline rename contract:
 * the full filename stays visible and editable, the filename stem is selected
 * so the user can immediately type to replace it, and the selection is
 * idempotent across multiple calls within the same rename session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup } from '@testing-library/react';
import {
  __resetRenameInputAffordanceForTesting,
  applyRenameInputAffordance,
  OK_RENAMING_ATTR,
} from './file-tree-rename-chip';

interface PierreRenameRowInit {
  /** `data-item-path` value — e.g., `AGENTS.md`, `notes/photo.jpg`, `docs/` for a folder. */
  path: string;
  /** Initial `<input>` value Pierre would seed (typically the full filename). */
  initialValue: string;
}

/**
 * Build a row that mirrors Pierre's render output during inline rename:
 *   <div data-type="item" data-item-path>
 *     <div data-item-section="icon">...</div>
 *     <div data-item-section="content">
 *       <input data-item-rename-input ... />
 *     </div>
 *     <div data-item-section="decoration" style="display:none">...</div>
 *     <div data-item-section="action" style="display:none"></div>
 *   </div>
 */
function buildPierreRenameRow(init: PierreRenameRowInit): {
  row: HTMLElement;
  input: HTMLInputElement;
  content: HTMLElement;
} {
  const row = document.createElement('div');
  row.setAttribute('data-type', 'item');
  row.setAttribute('data-item-path', init.path);

  const icon = document.createElement('div');
  icon.setAttribute('data-item-section', 'icon');
  row.appendChild(icon);

  const content = document.createElement('div');
  content.setAttribute('data-item-section', 'content');
  row.appendChild(content);

  const input = document.createElement('input');
  input.setAttribute('data-item-rename-input', 'true');
  input.setAttribute('aria-label', `Rename ${init.path}`);
  input.value = init.initialValue;
  content.appendChild(input);

  // Pierre hides these during rename via its own CSS; we still emit them so
  // the row's structural shape matches production.
  const decoration = document.createElement('div');
  decoration.setAttribute('data-item-section', 'decoration');
  decoration.style.display = 'none';
  row.appendChild(decoration);

  const action = document.createElement('div');
  action.setAttribute('data-item-section', 'action');
  action.style.display = 'none';
  row.appendChild(action);

  document.body.appendChild(row);
  return { row, input, content };
}

function buildPierreShadowRoot(): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  return shadow;
}

describe('applyRenameInputAffordance — keep extension editable + select filename stem', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  test('keeps `.md` in the input value and selects only the filename stem', () => {
    const { input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);

    expect(input.value).toBe('AGENTS.md');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('AGENTS'.length);
  });

  test('keeps `.mdx` editable and selects only the filename stem', () => {
    const { input } = buildPierreRenameRow({
      path: 'notes/ideas.mdx',
      initialValue: 'ideas.mdx',
    });
    applyRenameInputAffordance(document);

    expect(input.value).toBe('ideas.mdx');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('ideas'.length);
  });

  test('keeps asset extensions editable and selects only the stem', () => {
    const { input } = buildPierreRenameRow({
      path: '.mcp.json',
      initialValue: '.mcp.json',
    });
    applyRenameInputAffordance(document);

    expect(input.value).toBe('.mcp.json');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('.mcp'.length);
  });

  test('new file placeholder shows `Untitled.md` and selects `Untitled`', () => {
    const { input } = buildPierreRenameRow({
      path: 'Untitled.md',
      initialValue: 'Untitled.md',
    });
    applyRenameInputAffordance(document);

    expect(input.value).toBe('Untitled.md');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Untitled'.length);
  });

  test('folder rows (path ends with `/`) are ignored', () => {
    const { input } = buildPierreRenameRow({
      path: 'docs/',
      initialValue: 'docs',
    });
    applyRenameInputAffordance(document);

    expect(input.value).toBe('docs');
  });

  test('extension-less files keep their value and select the full filename', () => {
    const { input } = buildPierreRenameRow({
      path: 'Makefile',
      initialValue: 'Makefile',
    });
    applyRenameInputAffordance(document);

    expect(input.value).toBe('Makefile');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Makefile'.length);
  });

  test('idempotent — repeated calls during the same rename session do not re-select', () => {
    const { input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(input.value).toBe('AGENTS.md');

    // Simulate the user typing — Pierre fires its onInput, which updates
    // the value via renameView. The user types inside the selected stem.
    input.value = 'AGENTS-edited.md';
    input.setSelectionRange(10, 13); // caret somewhere inside the typed text

    // The observer fires again on the next DOM mutation. Re-applying must
    // NOT clobber the user's value or selection.
    applyRenameInputAffordance(document);
    expect(input.value).toBe('AGENTS-edited.md');
    expect(input.selectionStart).toBe(10);
    expect(input.selectionEnd).toBe(13);
  });

  test('idempotent across user editing the extension', () => {
    const { input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(input.value).toBe('AGENTS.md');

    input.value = 'AGENTS.mdx';
    input.setSelectionRange('AGENTS.'.length, 'AGENTS.mdx'.length);
    applyRenameInputAffordance(document);
    expect(input.value).toBe('AGENTS.mdx');
    expect(input.selectionStart).toBe('AGENTS.'.length);
    expect(input.selectionEnd).toBe('AGENTS.mdx'.length);
  });

  test('survives ShadowRoot context — find works through the open shadow root', () => {
    const shadow = buildPierreShadowRoot();
    const row = document.createElement('div');
    row.setAttribute('data-type', 'item');
    row.setAttribute('data-item-path', 'AGENTS.md');
    const content = document.createElement('div');
    content.setAttribute('data-item-section', 'content');
    row.appendChild(content);
    const input = document.createElement('input');
    input.setAttribute('data-item-rename-input', 'true');
    input.value = 'AGENTS.md';
    content.appendChild(input);
    shadow.appendChild(row);

    applyRenameInputAffordance(shadow);

    expect(input.value).toBe('AGENTS.md');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('AGENTS'.length);
  });

  test('no rename input present — no-op', () => {
    // A row with no rename input — applyRenameInputAffordance should just return.
    const row = document.createElement('div');
    row.setAttribute('data-type', 'item');
    row.setAttribute('data-item-path', 'AGENTS.md');
    const content = document.createElement('div');
    content.setAttribute('data-item-section', 'content');
    row.appendChild(content);
    document.body.appendChild(row);

    expect(() => applyRenameInputAffordance(document)).not.toThrow();
  });
});

/**
 * Regression cover for the rename-flash icon overlay. Pierre's optimistic
 * commit briefly puts the row in an extensionless state (`data-item-path`
 * loses the extension), at which point Pierre swaps the icon's
 * `data-icon-token` from `markdown` to `default`. The overlay mechanism
 * keeps the renamed row marked with `data-ok-renaming=".md"` across that
 * commit-window so a CSS overlay can hide the wrong icon and render a
 * markdown glyph until the disk-truth `/api/documents` refresh restores
 * the extension.
 *
 * Pins:
 *   - On rename-input mount, the row is NOT stamped with the marker, so the
 *     normal icon remains visible while the input is open.
 *   - When Pierre's commit removes the input and switches the row to an
 *     extensionless path, the marker is RE-APPLIED to the selected row.
 *   - Non-markdown assets never enter overlay state.
 *   - When the disk-truth refresh restores the extension, the marker is
 *     dropped (no lingering overlay on a settled file).
 *   - Legitimate extensionless files (`Makefile`, `Dockerfile`) NEVER pick
 *     up the marker — even mid-rename of a different doc.
 */
describe('applyRenameInputAffordance — overlay marker for symptom 2 (icon-flash bridge)', () => {
  beforeEach(() => {
    __resetRenameInputAffordanceForTesting();
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    __resetRenameInputAffordanceForTesting();
  });

  test('rename-input mount does not stamp the row, avoiding a duplicate markdown icon', () => {
    const { row } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);

    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });

  test('non-markdown asset renames never stamp the overlay marker', () => {
    const { row, input } = buildPierreRenameRow({
      path: '.mcp.json',
      initialValue: '.mcp.json',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    input.remove();
    row.setAttribute('data-item-path', '.mcp');
    row.setAttribute('data-item-selected', 'true');
    applyRenameInputAffordance(document);

    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });

  test('after Pierre commits — selected extensionless row gets the marker reapplied', () => {
    // Phase 1: rename input mounts.
    const { row, input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    // Phase 2: simulate Pierre's optimistic commit — the input is gone,
    // the row's path lost its extension, and Pierre's Preact reconciliation
    // dropped our marker (mirrors production: at the moment the icon swaps
    // to `data-icon-token="default"`, the row attribute is null).
    input.remove();
    row.setAttribute('data-item-path', 'AGENTS-RENAMED');
    row.setAttribute('data-item-selected', 'true');
    row.removeAttribute(OK_RENAMING_ATTR);

    // The observer fires on Pierre's attribute mutation and re-invokes
    // applyRenameInputAffordance. The overlay-maintenance pass MUST re-stamp the row.
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBe('.md');
  });

  test('legitimate extensionless files NEVER pick up the marker mid-rename', () => {
    // Phase 1: an unrelated, legitimate extensionless file is in the tree
    // alongside the file being renamed.
    const makefileRow = document.createElement('div');
    makefileRow.setAttribute('data-type', 'item');
    makefileRow.setAttribute('data-item-path', 'Makefile');
    document.body.appendChild(makefileRow);

    const { input } = buildPierreRenameRow({
      path: 'docs/photo.md',
      initialValue: 'docs/photo.md',
    });
    applyRenameInputAffordance(document);

    // Phase 2: Pierre commits the rename. The renamed row's path is now
    // extensionless. Makefile remains as a sibling. NEITHER row is
    // selected yet — the renamed row's selection has not been re-asserted.
    input.remove();

    // Phase 3: observer ticks again. Selected=false on both rows.
    // The Makefile must NOT pick up the marker.
    applyRenameInputAffordance(document);
    expect(makefileRow.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    // Phase 4: the renamed row becomes selected. Marker reapplies to it,
    // but Makefile is untouched.
    const renamedRow = document.body.querySelector(
      '[data-item-path="docs/photo.md"]',
    ) as HTMLElement | null;
    expect(renamedRow).not.toBeNull();
    if (!renamedRow) return;
    renamedRow.setAttribute('data-item-path', 'docs/photo-renamed');
    renamedRow.setAttribute('data-item-selected', 'true');
    renamedRow.removeAttribute(OK_RENAMING_ATTR);

    applyRenameInputAffordance(document);

    expect(renamedRow.getAttribute(OK_RENAMING_ATTR)).toBe('.md');
    expect(makefileRow.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });

  test('disk-truth refresh — marker is dropped once the path includes the saved extension', () => {
    // Phase 1: rename input mounts.
    const { row, input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    // Phase 2: Pierre commits (input gone, path extensionless, marker
    // restamped via overlay maintenance).
    input.remove();
    row.setAttribute('data-item-path', 'AGENTS-RENAMED');
    row.setAttribute('data-item-selected', 'true');
    row.removeAttribute(OK_RENAMING_ATTR);
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBe('.md');

    // Phase 3: disk-truth refresh restores the extension. The path now
    // ends with `.md` — the marker must clear so the CSS overlay stops
    // covering Pierre's (correct) markdown icon.
    row.setAttribute('data-item-path', 'AGENTS-RENAMED.md');
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });

  test('row recycled to an unrelated file (different extension) — marker is dropped', () => {
    // Phase 1: rename input mounts on .md rename.
    const { row, input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    // Phase 2: Pierre recycles this DOM element to a totally unrelated
    // file (different extension), simulating row repositioning after
    // re-sort. The marker must drop so its overlay doesn't show on the
    // unrelated file.
    input.remove();
    row.setAttribute('data-item-path', 'images/cat.jpg');
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });

  test('post-settle: module-level activeRenameExt is cleared (Makefile selected later gets no marker)', () => {
    // Pins that `activeRenameExt` clears once disk-truth refreshes the
    // extension and no rename input is open. The existing "disk-truth refresh"
    // test pins row-attribute removal; this one pins that the module-level
    // state was also reset.

    // Phase 1: full rename cycle: input mounts, Pierre commits, disk
    // truth refreshes. Marker drops via the settle branch.
    const { row, input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    input.remove();
    row.setAttribute('data-item-path', 'AGENTS-RENAMED.md'); // disk-truth refresh
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    // Phase 2: a brand-new extensionless file is selected by the user.
    // If `activeRenameExt` were still set, this Makefile would pick up
    // the marker on the next observer tick. Assert it doesn't.
    const makefileRow = document.createElement('div');
    makefileRow.setAttribute('data-type', 'item');
    makefileRow.setAttribute('data-item-path', 'Makefile');
    makefileRow.setAttribute('data-item-selected', 'true');
    document.body.appendChild(makefileRow);

    applyRenameInputAffordance(document);
    expect(makefileRow.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });
});
