import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CONFLICT_SCROLLPORT_SELECTOR,
  DOCUMENT_SCROLL_HOST_SELECTOR,
  DOCUMENT_SCROLLPORT_SELECTORS,
  FULL_PAGE_CM_HOST_SELECTORS,
} from './editor/document-scrollports';
import {
  type CssBlock,
  collectBlocks,
  readGlobalsCssWithoutComments,
  splitSelectorList,
} from './globals-css.test-helper';

const SRC_ROOT = import.meta.dirname;

const RESET_PRELUDE = '.cm-editor .cm-content';

const INSET_VAR = '--ask-composer-height';

const INSET_VALUE = `var(${INSET_VAR}`;

const INSET_VAR_ALLOWED_OUTSIDE_GLOBALS_CSS = [
  'components/BottomComposer.tsx',
  'editor/utils/editor-visible-region.ts',
] as const;

type InsetKind = 'content' | 'host';

type FullPageCmHostKey = keyof typeof FULL_PAGE_CM_HOST_SELECTORS;

type DocumentScrollportSelector = (typeof DOCUMENT_SCROLLPORT_SELECTORS)[number];

interface FullPageCmSurface {
  component: string;
  insetKind: InsetKind;
}

const FULL_PAGE_CM_SURFACES: Readonly<Record<FullPageCmHostKey, FullPageCmSurface>> = {
  textDocEditor: { component: 'components/TextDocEditor.tsx', insetKind: 'content' },
  sourceEditor: { component: 'editor/SourceEditor.tsx', insetKind: 'content' },
  mermaidDocEditor: { component: 'components/MermaidDocEditor.tsx', insetKind: 'host' },
};

const FULL_PAGE_CM_SURFACE_CASES = Object.entries(FULL_PAGE_CM_SURFACES).map(([host, surface]) => ({
  ...surface,
  hostSelector: FULL_PAGE_CM_HOST_SELECTORS[host as FullPageCmHostKey],
}));

interface ComposerInsetRule {
  prelude: string;
  scrollport: DocumentScrollportSelector;
}

const COMPOSER_INSET_RULES: readonly ComposerInsetRule[] = [
  { prelude: DOCUMENT_SCROLL_HOST_SELECTOR, scrollport: DOCUMENT_SCROLL_HOST_SELECTOR },
  {
    prelude: `${DOCUMENT_SCROLL_HOST_SELECTOR} :is(.ProseMirror, .cm-content)`,
    scrollport: DOCUMENT_SCROLL_HOST_SELECTOR,
  },
  {
    prelude: `${FULL_PAGE_CM_HOST_SELECTORS.sourceEditor} .cm-content`,
    scrollport: DOCUMENT_SCROLL_HOST_SELECTOR,
  },
  {
    prelude: `${FULL_PAGE_CM_HOST_SELECTORS.textDocEditor} .cm-content`,
    scrollport: `${FULL_PAGE_CM_HOST_SELECTORS.textDocEditor} .cm-scroller`,
  },
  {
    prelude: FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor,
    scrollport: `${FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor} .cm-scroller`,
  },
  { prelude: CONFLICT_SCROLLPORT_SELECTOR, scrollport: CONFLICT_SCROLLPORT_SELECTOR },
  {
    prelude: `${CONFLICT_SCROLLPORT_SELECTOR} diffs-container`,
    scrollport: CONFLICT_SCROLLPORT_SELECTOR,
  },
];

const FULL_PAGE_CM_THEME = /EditorView\.theme\(\s*\{[\s\S]{0,120}?height:\s*'100%'/;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(tsx?|jsx?)$/.test(entry.name) &&
        !/\.(test|test-helper)\.(tsx?|jsx?)$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(dir, file).split(sep).includes('locales'));
}

function listStylesheetFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => join(entry.parentPath, entry.name));
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

function owningSelector(block: CssBlock): string | null {
  for (const prelude of [...block.ancestors, block.prelude].toReversed()) {
    if (!prelude.startsWith('@')) return prelude;
  }
  return null;
}

function insetBearingSelectors(css: string): string[] {
  const found = new Set<string>();
  for (const block of collectBlocks(css)) {
    if (!block.declarations.includes(INSET_VALUE)) continue;
    const owner = owningSelector(block);
    if (owner === null) continue;
    for (const selector of splitSelectorList(owner)) found.add(selector);
  }
  return [...found].toSorted();
}

function composerInsetOffset(css: string, prelude: string): number | null {
  for (const offset of ruleOffsets(css, prelude)) {
    if (declarationBlockAt(css, offset).includes(INSET_VALUE)) return offset;
  }
  return null;
}

describe('full-page CodeMirror surfaces reserve the Ask AI composer height', () => {
  const css = readGlobalsCssWithoutComments();

  test('every registered surface is keyed by a host in the shared record', () => {
    expect(
      Object.keys(FULL_PAGE_CM_SURFACES).toSorted(),
      'this table is keyed by `FULL_PAGE_CM_HOST_SELECTORS` and indexes its host selector out ' +
        'rather than restating it as a sibling field, so a surface can no longer be paired with ' +
        "another surface's selector and still satisfy every assertion here. A host in the record " +
        'with no entry here has nothing checking it reserves the composer height, and repeats the ' +
        'end-of-document burial this registry exists to stop',
    ).toEqual(Object.keys(FULL_PAGE_CM_HOST_SELECTORS).toSorted());
  });

  test('every globals.css rule that reserves the composer inset names a scrollport', () => {
    expect(
      insetBearingSelectors(css),
      'a selector in globals.css reserves `--ask-composer-height` but is not accounted for here, ' +
        'or an accounted-for selector no longer reserves it. This equality and its sibling below ' +
        'are set-wise, one direction each: together they prove no inset rule is missing from the ' +
        'table and no enumerated scrollport is dead weight. Neither reads the two fields of one ' +
        'row together, so pairing a row with the scrollport that actually scrolls its prelude is ' +
        'on the author. Without this equality a new surface can take its inset and never reach ' +
        '`documentScrollports`, which is the bug this module exists to stop, one level up. Add a ' +
        '`COMPOSER_INSET_RULES` row naming the scrollport that scrolls this prelude, and add that ' +
        'scrollport to `DOCUMENT_SCROLLPORT_SELECTORS` if it is new',
    ).toEqual([...new Set(COMPOSER_INSET_RULES.map((rule) => rule.prelude))].toSorted());
  });

  test('every scrollport the composer re-clamps compensates a real inset rule', () => {
    expect(
      [...new Set(COMPOSER_INSET_RULES.map((rule) => rule.scrollport))].toSorted(),
      'a member of `DOCUMENT_SCROLLPORT_SELECTORS` compensates no globals.css inset rule, so the ' +
        'composer re-clamps an element that reserves no room for it. That member is either dead ' +
        'weight reading as coverage its surface does not have, or the surface lost its inset rule',
    ).toEqual([...DOCUMENT_SCROLLPORT_SELECTORS].toSorted());
  });

  test('the conflict surface, enumerated as a literal rather than through the record, reserves the composer height', () => {
    expect(
      composerInsetOffset(css, `${CONFLICT_SCROLLPORT_SELECTOR} diffs-container`),
      `\`${CONFLICT_SCROLLPORT_SELECTOR}\` reaches \`documentScrollports\` as a bare literal, so ` +
        'nothing else ties it to the inset it exists to compensate. Renaming this prelude leaves ' +
        'the composer clamping a scrollport that reserves no room, and every other test green',
    ).not.toBeNull();
  });

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

  test.each(FULL_PAGE_CM_SURFACE_CASES)(
    '$component reserves the composer height and wins the tie against the reset',
    ({ component, hostSelector, insetKind }) => {
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
    },
  );

  test.each(FULL_PAGE_CM_SURFACE_CASES)(
    '$component reserves exactly one composer height',
    ({ hostSelector }) => {
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
    },
  );

  test('no other component mounts a full-page CodeMirror without an entry here', () => {
    const registered = new Set(
      Object.values(FULL_PAGE_CM_SURFACES).map((surface) => join(SRC_ROOT, surface.component)),
    );
    const unregistered = listSourceFiles(SRC_ROOT)
      .filter((file) => !registered.has(file))
      .filter(mountsFullPageCodeMirror)
      .map((file) => file.slice(SRC_ROOT.length + 1));
    expect(
      unregistered,
      'these components match the full-page CodeMirror syntax detector (`EditorView.theme(...)` ' +
        "with `height: '100%'`) but are not registered above, so nothing checks that they reserve " +
        'the composer height. Add each to FULL_PAGE_CM_SURFACES under the FULL_PAGE_CM_HOST_SELECTORS ' +
        'key whose selector its globals.css inset rule uses, or tighten the detector if the match ' +
        'is not a full-page surface',
    ).toEqual([]);
  });

  test('an inset nested in an at-rule inside a style rule is attributed to that rule', () => {
    expect(
      insetBearingSelectors(
        `.new-surface { @media (min-width: 40rem) { padding-bottom: ${INSET_VALUE}, 0px); } }`,
      ),
      'skipping every `@`-prefixed prelude rather than descending through it attributes this ' +
        'inset to nothing and returns an empty list, which reads exactly like a stylesheet that ' +
        'reserves nothing. A surface that takes its inset only under a media query would then ' +
        'never reach `documentScrollports` and nothing here would say so. The shape is reachable: ' +
        'globals.css already nests `@starting-style` inside a style rule, and Tailwind v4 flattens ' +
        'that nesting through Lightning CSS at build time',
    ).toEqual(['.new-surface']);
  });

  test('an inset nested in a @supports probe inside a style rule is attributed to that rule', () => {
    expect(
      insetBearingSelectors(
        `.probed-surface { @supports (height: 1lh) { padding-bottom: ${INSET_VALUE}, 0px); } }`,
      ),
      'the @supports spelling of the nesting above has to resolve to the same owning selector, ' +
        'otherwise the fix covers one at-rule keyword rather than the class',
    ).toEqual(['.probed-surface']);
  });

  test('a style rule nested inside an at-rule is still attributed to the style rule', () => {
    expect(
      insetBearingSelectors(
        `@media (min-width: 40rem) { .outer-nested { padding-bottom: ${INSET_VALUE}, 0px); } }`,
      ),
      'outer nesting was already handled and has to stay handled: the selector, not the media ' +
        'query wrapping it, is what the composer clamps',
    ).toEqual(['.outer-nested']);
  });

  test('a declaration with no style rule anywhere above it is attributed to no selector', () => {
    expect(
      insetBearingSelectors(`@media (min-width: 40rem) { padding-bottom: ${INSET_VALUE}, 0px); }`),
      'an at-rule that carries the declaration directly has no selector to name, so it cannot ' +
        'produce a scrollport row. Reporting the at-rule prelude as a selector would put ' +
        '`@media (min-width: 40rem)` into a table of things the composer re-clamps',
    ).toEqual([]);
  });

  test('nothing outside globals.css reserves the composer inset where this guard cannot see it', () => {
    const allowed = new Set(
      INSET_VAR_ALLOWED_OUTSIDE_GLOBALS_CSS.map((rel) => join(SRC_ROOT, rel)),
    );
    const offenders = [
      ...listSourceFiles(SRC_ROOT),
      ...listStylesheetFiles(SRC_ROOT).filter((file) => file !== join(SRC_ROOT, 'globals.css')),
    ]
      .filter((file) => !allowed.has(file))
      .filter((file) => readFileSync(file, 'utf-8').includes(INSET_VAR))
      .map((file) => file.slice(SRC_ROOT.length + 1))
      .toSorted();
    expect(
      offenders,
      `these files name \`${INSET_VAR}\` outside globals.css, which is the one stylesheet every ` +
        'other assertion in this file reads. The idiomatic way to reserve the inset on a new ' +
        'surface here is a Tailwind arbitrary value in a `className` (`pb-[var(' +
        `${INSET_VAR},0px)]\`), and this repo already carries about thirty arbitrary-value ` +
        '`var()` classes, so the bypass is house style rather than hypothetical. Tailwind compiles ' +
        'those to CSS at build time and jsdom never applies the result, so no runtime assertion ' +
        'can reach them and a source scan is the only place this is checkable. Move the rule into ' +
        'globals.css and register it in `COMPOSER_INSET_RULES`, or allowlist the file above if it ' +
        'publishes the variable rather than consuming it',
    ).toEqual([]);
  });

  test('each allowlisted publisher still names the inset variable', () => {
    const stale = INSET_VAR_ALLOWED_OUTSIDE_GLOBALS_CSS.filter(
      (rel) => !readFileSync(join(SRC_ROOT, rel), 'utf-8').includes(INSET_VAR),
    );
    expect(
      stale,
      `these files are allowlisted from the scan above but no longer mention \`${INSET_VAR}\`, so ` +
        'the allowlist is holding open an exemption nothing uses. A later file moved to one of ' +
        'these paths would inherit a blanket pass',
    ).toEqual([]);
  });

  test('the registry is not silently empty', () => {
    expect(Object.keys(FULL_PAGE_CM_SURFACES).length).toBeGreaterThan(0);
    const found = listSourceFiles(SRC_ROOT).filter(mountsFullPageCodeMirror);
    expect(
      found.length,
      'the full-page CodeMirror detector matched nothing at all, so the completeness test above ' +
        'passes by finding nothing rather than by finding everything registered',
    ).toBe(Object.keys(FULL_PAGE_CM_SURFACES).length);
  });
});
