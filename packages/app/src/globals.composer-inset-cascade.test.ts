import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  FULL_PAGE_CM_HOST_SELECTORS,
  readGlobalsCssWithoutComments,
} from './globals-css.test-helper';

const SRC_ROOT = import.meta.dirname;

const RESET_PRELUDE = '.cm-editor .cm-content';

const INSET_VALUE = 'var(--ask-composer-height';

type InsetKind = 'content' | 'host';

interface FullPageCmSurface {
  component: string;
  hostSelector: string;
  insetKind: InsetKind;
}

const FULL_PAGE_CM_SURFACES: readonly FullPageCmSurface[] = [
  {
    component: 'components/TextDocEditor.tsx',
    hostSelector: FULL_PAGE_CM_HOST_SELECTORS.textDocEditor,
    insetKind: 'content',
  },
  {
    component: 'editor/SourceEditor.tsx',
    hostSelector: FULL_PAGE_CM_HOST_SELECTORS.sourceEditor,
    insetKind: 'content',
  },
  {
    component: 'components/MermaidDocEditor.tsx',
    hostSelector: FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor,
    insetKind: 'host',
  },
];

const FULL_PAGE_CM_THEME = /EditorView\.theme\(\s*\{[\s\S]{0,120}?height:\s*'100%'/;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|test-helper|dom\.test)\.tsx?$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(dir, file).split(sep).includes('locales'));
}

function mountsFullPageCodeMirror(absPath: string): boolean {
  return FULL_PAGE_CM_THEME.test(readFileSync(absPath, 'utf-8'));
}

function ruleOffsets(css: string, prelude: string): number[] {
  const escaped = prelude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[,{}])\\s*${escaped}\\s*(,|\\{)`, 'g');
  const offsets: number[] = [];
  for (let m = pattern.exec(css); m !== null; m = pattern.exec(css)) offsets.push(m.index);
  return offsets;
}

function declarationBlockAt(css: string, offset: number): string {
  const open = css.indexOf('{', offset);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

function composerInsetOffset(css: string, prelude: string): number | null {
  for (const offset of ruleOffsets(css, prelude)) {
    if (declarationBlockAt(css, offset).includes(INSET_VALUE)) return offset;
  }
  return null;
}

describe('full-page CodeMirror surfaces reserve the Ask AI composer height', () => {
  const css = readGlobalsCssWithoutComments();

  test('the padding reset that every full-page CM surface has to undo is still there', () => {
    const resetOffsets = ruleOffsets(css, RESET_PRELUDE);
    expect(
      resetOffsets.length,
      `no \`${RESET_PRELUDE}\` rule in globals.css. Every assertion below is about ` +
        'surviving that reset, so its absence makes this whole file vacuous rather than green',
    ).toBeGreaterThan(0);
    const zeroing = resetOffsets.some((offset) =>
      /padding:\s*0/.test(declarationBlockAt(css, offset)),
    );
    expect(
      zeroing,
      `\`${RESET_PRELUDE}\` no longer zeroes padding. If the reset stopped applying, the ` +
        'per-surface restores below are dead weight and the shared ' +
        '`.editor-doc-scroll :is(.ProseMirror, .cm-content)` inset reaches these surfaces directly',
    ).toBe(true);
  });

  test.each(
    FULL_PAGE_CM_SURFACES,
  )('$component reserves the composer height and wins the tie against the reset', ({
    component,
    hostSelector,
    insetKind,
  }) => {
    const prelude = insetKind === 'content' ? `${hostSelector} .cm-content` : hostSelector;
    const insetOffset = composerInsetOffset(css, prelude);
    expect(
      insetOffset,
      `${component} mounts a full-page CodeMirror but no \`${prelude}\` rule in globals.css ` +
        `sets \`padding-bottom: ${INSET_VALUE}…)\`. Its last lines sit under the floating Ask AI ` +
        'composer with no way to scroll them clear, which is the bug this registry exists to stop',
    ).not.toBeNull();
    if (insetKind !== 'content' || insetOffset === null) return;
    const resetOffset = Math.max(...ruleOffsets(css, RESET_PRELUDE));
    expect(
      insetOffset,
      `\`${prelude}\` ties \`${RESET_PRELUDE}\` on specificity (0,2,0), so document order breaks ` +
        'the tie. Declared before the reset it loses and the inset silently collapses to 0',
    ).toBeGreaterThan(resetOffset);
  });

  test.each(FULL_PAGE_CM_SURFACES)('$component reserves exactly one composer height', ({
    hostSelector,
  }) => {
    const insetOffsets = [
      composerInsetOffset(css, hostSelector),
      composerInsetOffset(css, `${hostSelector} .cm-content`),
    ].filter((offset) => offset !== null);
    expect(
      insetOffsets,
      `\`${hostSelector}\` must reserve the composer height on EITHER its host OR its ` +
        '`.cm-content`, never both. Zero leaves the last lines under the composer; two reserves ' +
        'double the gap and make the last line float a full card above it',
    ).toHaveLength(1);
  });

  test('no other component mounts a full-page CodeMirror without an entry here', () => {
    const registered = new Set(
      FULL_PAGE_CM_SURFACES.map((surface) => join(SRC_ROOT, surface.component)),
    );
    const unregistered = listSourceFiles(SRC_ROOT)
      .filter((file) => !registered.has(file))
      .filter(mountsFullPageCodeMirror)
      .map((file) => file.slice(SRC_ROOT.length + 1));
    expect(
      unregistered,
      'these components match the full-page CodeMirror syntax detector (`EditorView.theme(...)` ' +
        "with `height: '100%'`) but are not registered above, so nothing checks that they reserve " +
        'the composer height. Add each to FULL_PAGE_CM_SURFACES with the host selector its ' +
        'globals.css inset rule uses, or tighten the detector if the match is not a full-page surface',
    ).toEqual([]);
  });

  test('the registry is not silently empty', () => {
    expect(FULL_PAGE_CM_SURFACES.length).toBeGreaterThan(0);
    const found = listSourceFiles(SRC_ROOT).filter(mountsFullPageCodeMirror);
    expect(
      found.length,
      'the full-page CodeMirror detector matched nothing at all, so the completeness test above ' +
        'passes by finding nothing rather than by finding everything registered',
    ).toBe(FULL_PAGE_CM_SURFACES.length);
  });
});
