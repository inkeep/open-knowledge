import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup } from '@testing-library/react';
import {
  __resetRenameInputAffordanceForTesting,
  applyRenameInputAffordance,
  OK_RENAMING_ATTR,
} from './file-tree-rename-chip';

interface PierreRenameRowInit {
  path: string;
  initialValue: string;
}

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

    input.value = 'AGENTS-edited.md';
    input.setSelectionRange(10, 13); // caret somewhere inside the typed text

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
    const { row, input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    input.remove();
    row.setAttribute('data-item-path', 'AGENTS-RENAMED');
    row.setAttribute('data-item-selected', 'true');
    row.removeAttribute(OK_RENAMING_ATTR);

    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBe('.md');
  });

  test('legitimate extensionless files NEVER pick up the marker mid-rename', () => {
    const makefileRow = document.createElement('div');
    makefileRow.setAttribute('data-type', 'item');
    makefileRow.setAttribute('data-item-path', 'Makefile');
    document.body.appendChild(makefileRow);

    const { input } = buildPierreRenameRow({
      path: 'docs/photo.md',
      initialValue: 'docs/photo.md',
    });
    applyRenameInputAffordance(document);

    input.remove();

    applyRenameInputAffordance(document);
    expect(makefileRow.getAttribute(OK_RENAMING_ATTR)).toBeNull();

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
    const { row, input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    input.remove();
    row.setAttribute('data-item-path', 'AGENTS-RENAMED');
    row.setAttribute('data-item-selected', 'true');
    row.removeAttribute(OK_RENAMING_ATTR);
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBe('.md');

    row.setAttribute('data-item-path', 'AGENTS-RENAMED.md');
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });

  test('row recycled to an unrelated file (different extension) — marker is dropped', () => {
    const { row, input } = buildPierreRenameRow({
      path: 'AGENTS.md',
      initialValue: 'AGENTS.md',
    });
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();

    input.remove();
    row.setAttribute('data-item-path', 'images/cat.jpg');
    applyRenameInputAffordance(document);
    expect(row.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });

  test('post-settle: module-level activeRenameExt is cleared (Makefile selected later gets no marker)', () => {
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

    const makefileRow = document.createElement('div');
    makefileRow.setAttribute('data-type', 'item');
    makefileRow.setAttribute('data-item-path', 'Makefile');
    makefileRow.setAttribute('data-item-selected', 'true');
    document.body.appendChild(makefileRow);

    applyRenameInputAffordance(document);
    expect(makefileRow.getAttribute(OK_RENAMING_ATTR)).toBeNull();
  });
});
