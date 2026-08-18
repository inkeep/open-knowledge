// @vitest-environment jsdom
/**
 * Unit tests for the WYSIWYG lint→block mapping. `mapDiagnosticsToBlocks`
 * groups source-line diagnostics by the top-level mdast block they fall in,
 * which is what the plugin then maps onto top-level PM nodes (1:1 by the
 * bridge invariant — the fragment derives from parse of the same Y.Text
 * source the diagnostics were linted against).
 *
 * The Problems-row navigation is covered against a real mounted editor at the
 * bottom of this file, so jsdom is on for the whole file; the pure mapping
 * tests are unaffected by it.
 */

import {
  sharedExtensions as coreExtensions,
  DEFAULT_LINTER_CONFIG,
  type LintDiagnostic,
  type LinterConfig,
  MarkdownManager,
} from '@inkeep/open-knowledge-core';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LINT_NAV_EVENT, type LintNavDetail } from '@/components/ProblemsPanel';
import { blockIndexForLine, computeSourceBlockSpans } from '../block-spans.ts';
import {
  __resetScrollRestoreCoordination,
  registerLandingScrollOwner,
} from '../scroll-restore-coordination.ts';
import { MarkdownLintDecorations, mapDiagnosticsToBlocks } from './markdown-lint-decorations.ts';

const md = new MarkdownManager({ extensions: coreExtensions });

function diag(line: number, over: Partial<LintDiagnostic> = {}): LintDiagnostic {
  // `line` is 1-based (the mdast/source convention these tests reason in).
  return {
    range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
    severity: 'warning',
    source: 'markdownlint',
    code: 'MD010',
    message: 'Hard tabs',
    ...over,
  };
}

describe('mapDiagnosticsToBlocks', () => {
  test('returns an empty map for no diagnostics', () => {
    expect(mapDiagnosticsToBlocks('# A\n\nbody\n', [], md).size).toBe(0);
  });

  // body:
  //   1: # Heading
  //   2:
  //   3: First paragraph.
  //   4:
  //   5: Second paragraph.
  const body = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';

  test('maps a diagnostic to the block index that contains its line', () => {
    // line 1 → block 0 (heading), line 3 → block 1, line 5 → block 2.
    const byBlock = mapDiagnosticsToBlocks(body, [diag(1), diag(3), diag(5)], md);
    expect([...byBlock.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(byBlock.get(0)?.[0]?.range.start.line).toBe(0);
    expect(byBlock.get(1)?.[0]?.range.start.line).toBe(2);
    expect(byBlock.get(2)?.[0]?.range.start.line).toBe(4);
  });

  test('groups multiple diagnostics on the same block', () => {
    const byBlock = mapDiagnosticsToBlocks(body, [diag(3), diag(3, { code: 'MD009' })], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.get(1)).toHaveLength(2);
  });

  test('maps any line within a multi-line block to that one block', () => {
    // A fenced code block spans several source lines; a diagnostic on any of
    // them belongs to the single code block.
    const codeBody = 'intro para\n\n```\nline a\nline b\n```\n';
    // lines: 1 para, 3-6 code fence
    const byBlock = mapDiagnosticsToBlocks(codeBody, [diag(4)], md);
    expect(byBlock.size).toBe(1);
    // block 0 = paragraph, block 1 = code
    expect(byBlock.has(1)).toBe(true);
  });

  test('anchors a between-block diagnostic (blank-line run) to the NEXT block', () => {
    // line 2 is the blank line between heading and paragraph — where rules
    // like MD012 (multiple blank lines) report. It anchors to the following
    // block instead of being dropped.
    const byBlock = mapDiagnosticsToBlocks(body, [diag(2, { code: 'MD012' })], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.has(1)).toBe(true);
  });

  test('anchors a trailing diagnostic (past the last block) to the LAST block', () => {
    // e.g. MD047 (file should end with a single newline) on a trailing blank.
    const byBlock = mapDiagnosticsToBlocks(body, [diag(6, { code: 'MD047' })], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.has(2)).toBe(true);
  });

  test('keeps a loose list as a single block (line-span, not blank-line split)', () => {
    // A loose list has blank lines between items but is ONE top-level block —
    // both item diagnostics must land on the same block index.
    const listBody = '- one\n\n- two\n\n- three\n';
    const byBlock = mapDiagnosticsToBlocks(listBody, [diag(1), diag(5)], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.get(0)).toHaveLength(2);
  });

  // source with frontmatter:
  //   1: ---
  //   2: title: X
  //   3: ---
  //   4: # Heading
  //   5:
  //   6: Paragraph.
  const fmSource = '---\ntitle: X\n---\n# Heading\n\nParagraph.\n';

  test('shifts block mapping under a frontmatter region (full-source lines)', () => {
    // Diagnostics carry FULL-source lines (markdownlint skips the FM region
    // itself but keeps absolute numbering): line 4 → block 0, line 6 → block 1.
    const byBlock = mapDiagnosticsToBlocks(fmSource, [diag(4), diag(6)], md);
    expect([...byBlock.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  test('skips a diagnostic inside the frontmatter region (no WYSIWYG anchor)', () => {
    const byBlock = mapDiagnosticsToBlocks(fmSource, [diag(2)], md);
    expect(byBlock.size).toBe(0);
  });

  const fmDiag = (line: number, over: Partial<LintDiagnostic> = {}): LintDiagnostic =>
    diag(line, {
      source: 'frontmatter',
      code: 'required',
      message: 'Frontmatter property "status" is required',
      ...over,
    });

  test('skips a frontmatter violation on a doc with NO frontmatter region', () => {
    // The validator anchors a missing-`required` violation to the region's
    // opening fence. With no region there is no fence, so the line lands on
    // the first line of body text — which is not what is wrong. Marking it
    // would squiggle a correct heading on exactly the docs where the schema
    // error matters most.
    const byBlock = mapDiagnosticsToBlocks(body, [fmDiag(1)], md);
    expect(byBlock.size).toBe(0);
  });

  test('skips a frontmatter violation anchored to a key line inside the region', () => {
    const byBlock = mapDiagnosticsToBlocks(fmSource, [fmDiag(2, { code: 'enum' })], md);
    expect(byBlock.size).toBe(0);
  });

  test('skips a frontmatter violation anchored PAST the frontmatter region', () => {
    // The one case that separates the two guards: `fmSource` has a 3-line
    // region, so line 4 is body. The line-range guard would let this through;
    // only the producing-plugin check catches it. Without this, narrowing
    // `isFrontmatterAnchorless` back to a line check passes the whole suite.
    const byBlock = mapDiagnosticsToBlocks(fmSource, [fmDiag(4)], md);
    expect(byBlock.size).toBe(0);
  });

  test('still marks a markdownlint violation on body line 1 of a doc with no frontmatter', () => {
    // The frontmatter skip is by producing plugin, not by position — a
    // body-anchored rule on the same line must keep its decoration.
    const byBlock = mapDiagnosticsToBlocks(body, [diag(1)], md);
    expect(byBlock.has(0)).toBe(true);
  });

  test('drops only the frontmatter diagnostics from a mixed set', () => {
    const byBlock = mapDiagnosticsToBlocks(body, [fmDiag(1), diag(3)], md);
    expect([...byBlock.keys()]).toEqual([1]);
    expect(byBlock.get(1)).toHaveLength(1);
  });
});

describe('computeSourceBlockSpans', () => {
  test('spans are in full-source coordinates when frontmatter is present', () => {
    const { spans, fmLineCount } = computeSourceBlockSpans(
      '---\ntitle: X\n---\n# Heading\n\nParagraph.\n',
      md,
    );
    expect(fmLineCount).toBe(3);
    expect(spans).toEqual([
      { start: 4, end: 4 },
      { start: 6, end: 6 },
    ]);
  });

  test('no frontmatter → zero offset', () => {
    const { spans, fmLineCount } = computeSourceBlockSpans('# H\n\nP\n', md);
    expect(fmLineCount).toBe(0);
    expect(spans[0]).toEqual({ start: 1, end: 1 });
  });

  test('empty body → no spans', () => {
    expect(computeSourceBlockSpans('', md).spans).toHaveLength(0);
  });

  // Decorations and Problems-panel navigation are gated on spans matching the
  // PM doc's top-level children one for one. A preserved blank run adds
  // paragraphs the source parse alone does not see, so without a synthesized
  // span per blank line the whole feature silently switches off for any
  // document containing one.
  test('a preserved blank run keeps span/child parity', () => {
    const source = 'a\n\n\n\nb\n';
    expect(computeSourceBlockSpans(source, md).spans).toHaveLength(
      md.parse(source).content?.length ?? 0,
    );
  });

  test('each blank line of a run gets its own single-line span', () => {
    expect(computeSourceBlockSpans('a\n\n\n\nb\n', md).spans).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 3 },
      { start: 4, end: 4 },
      { start: 5, end: 5 },
    ]);
  });

  test('synthesized spans shift with frontmatter like every other span', () => {
    const { spans, fmLineCount } = computeSourceBlockSpans('---\nt: X\n---\na\n\n\nb\n', md);
    expect(fmLineCount).toBe(3);
    expect(spans).toEqual([
      { start: 4, end: 4 },
      { start: 6, end: 6 },
      { start: 7, end: 7 },
    ]);
  });
});

describe('diagnostics on a preserved blank run', () => {
  test('anchor to the blank line they are about, not the next block', () => {
    const byBlock = mapDiagnosticsToBlocks('a\n\n\n\nb\n', [diag(3)], md);
    expect([...byBlock.keys()]).toEqual([1]);
  });

  test('the canonical single blank line still anchors to the next block', () => {
    const byBlock = mapDiagnosticsToBlocks('a\n\nb\n', [diag(2)], md);
    expect([...byBlock.keys()]).toEqual([1]);
  });
});

describe('blockIndexForLine', () => {
  const spans = [
    { start: 1, end: 1 },
    { start: 3, end: 6 },
    { start: 8, end: 8 },
  ];

  test('line inside a span → that block', () => {
    expect(blockIndexForLine(spans, 4)).toBe(1);
  });

  test('line in a gap → the following block', () => {
    expect(blockIndexForLine(spans, 2)).toBe(1);
    expect(blockIndexForLine(spans, 7)).toBe(2);
  });

  test('line past the last span → the last block', () => {
    expect(blockIndexForLine(spans, 12)).toBe(2);
  });

  test('line on a span boundary → that block', () => {
    expect(blockIndexForLine(spans, 3)).toBe(1);
    expect(blockIndexForLine(spans, 6)).toBe(1);
    expect(blockIndexForLine(spans, 8)).toBe(2);
  });

  test('line before the first block → the first block', () => {
    const offset = [
      { start: 3, end: 4 },
      { start: 7, end: 8 },
    ];
    expect(blockIndexForLine(offset, 1)).toBe(0);
    expect(blockIndexForLine(offset, 5)).toBe(1);
  });

  test('no spans → null', () => {
    expect(blockIndexForLine([], 1)).toBeNull();
  });
});

describe('Problems-row navigation — scroll suppression', () => {
  const DOC = 'lint-nav-doc';
  // 1: # Heading / 2: blank / 3: First paragraph. / 4: blank / 5: Second paragraph.
  const BODY = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
  let editor: Editor | null = null;
  let host: HTMLElement | null = null;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: PropertyDescriptor | undefined;
  let originalFetch: typeof globalThis.fetch;

  /**
   * Mount the extension on a real editor. jsdom implements neither of the two
   * DOM surfaces this path turns on, so both are installed here: `offsetParent`
   * is the plugin's "am I the visible editor" gate, and `scrollIntoView` is the
   * observable the suppression guard controls.
   */
  function mountEditor(): Editor {
    host = document.createElement('div');
    document.body.appendChild(host);
    const mounted = new Editor({
      element: host,
      extensions: [
        ...coreExtensions,
        MarkdownLintDecorations.configure({ docName: DOC, getSource: () => BODY }),
      ],
      content: md.parse(BODY),
    });
    Object.defineProperty(mounted.view.dom, 'offsetParent', { value: host, configurable: true });
    return mounted;
  }

  function clickProblemsRow(line: number, source?: string): void {
    const detail: LintNavDetail = { docName: DOC, line, column: 1, source };
    window.dispatchEvent(new CustomEvent<LintNavDetail>(LINT_NAV_EVENT, { detail }));
  }

  beforeEach(() => {
    __resetScrollRestoreCoordination();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ effective: DEFAULT_LINTER_CONFIG }),
    ) as unknown as typeof fetch;
    scrollIntoView = vi.fn();
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    editor = mountEditor();
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    host?.remove();
    host = null;
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    globalThis.fetch = originalFetch;
    __resetScrollRestoreCoordination();
  });

  test('scrolls the diagnostic block into view and places the caret in it', () => {
    clickProblemsRow(3); // "First paragraph." — the second top-level block

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const { $from } = editor?.state.selection ?? {};
    expect($from?.parent.textContent).toBe('First paragraph.');
  });

  test('declines a frontmatter row rather than selecting the first body block', () => {
    // A missing-frontmatter violation reports on line 1, which on a doc with
    // no frontmatter is body text. Following it would scroll to and select a
    // block that has nothing wrong with it; the property panel owns that error.
    const before = editor?.state.selection.from;

    clickProblemsRow(1, 'frontmatter');

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(editor?.state.selection.from).toBe(before);
  });

  test('supersedes a position-preserving landing rather than standing down under it', () => {
    // The row the user clicked outranks the position a mode-switch toggle was
    // preserving. Standing the scroll down while still moving the caret would
    // leave them looking at a viewport that never went anywhere.
    const supersede = vi.fn();
    registerLandingScrollOwner(DOC, { yieldsToNavigation: true, supersede });

    clickProblemsRow(3);

    expect(supersede).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const { $from } = editor?.state.selection ?? {};
    expect($from?.parent.textContent).toBe('First paragraph.');
  });

  test('stands down whole while a landing that is itself a navigation owns the scroller', () => {
    registerLandingScrollOwner(DOC, { yieldsToNavigation: false, supersede: vi.fn() });
    const before = editor?.state.selection.$from.parent.textContent;

    clickProblemsRow(3);

    // Caret and scroll move together or not at all — a half-applied navigation
    // is the failure mode, not the fallback.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(editor?.state.selection.$from.parent.textContent).toBe(before);
  });

  test('a landing on another document does not gate this one', () => {
    registerLandingScrollOwner('some-other-doc', {
      yieldsToNavigation: false,
      supersede: vi.fn(),
    });

    clickProblemsRow(3);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe('hover callout — keyboard dismissal unwinds the pointer grace', () => {
  const DOC = 'lint-tooltip-doc';
  const BODY = '# Heading\n\nfirst paragraph\n\n\tindented with a hard tab\n';
  const ENABLED_CONFIG: LinterConfig = {
    enabled: true,
    plugins: {
      ...DEFAULT_LINTER_CONFIG.plugins,
      markdownlint: { enabled: true, rules: { default: true } },
    },
  };
  let editor: Editor | null = null;
  let host: HTMLElement | null = null;
  let originalFetch: typeof globalThis.fetch;
  let originalElementFromPoint: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ effective: ENABLED_CONFIG }),
    ) as unknown as typeof fetch;
    // The anchor computation hit-tests the pointer against the document, which
    // jsdom does not implement. Answering outside the editor takes the callout's
    // documented fallback (anchor to the block's own box) without needing the
    // text-node geometry jsdom also omits — the dismissal wiring under test
    // does not depend on which anchor was chosen.
    originalElementFromPoint = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'elementFromPoint',
    );
    Object.defineProperty(Document.prototype, 'elementFromPoint', {
      value: () => document.body,
      configurable: true,
      writable: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = new Editor({
      element: host,
      extensions: [
        ...coreExtensions,
        MarkdownLintDecorations.configure({ docName: DOC, getSource: () => BODY }),
      ],
      content: md.parse(BODY),
    });
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    host?.remove();
    host = null;
    if (originalElementFromPoint) {
      Object.defineProperty(Document.prototype, 'elementFromPoint', originalElementFromPoint);
    } else {
      Reflect.deleteProperty(Document.prototype, 'elementFromPoint');
    }
    globalThis.fetch = originalFetch;
  });

  /** jsdom has no PointerEvent; the handlers read only MouseEvent fields. */
  function pointer(type: string, init: MouseEventInit = {}): MouseEvent {
    return new MouseEvent(type, { bubbles: true, ...init });
  }

  test('a keydown taken with the pointer on the callout leaves the next hide working', async () => {
    const ed = editor;
    const mount = host;
    if (!ed || !mount) throw new Error('editor not mounted');
    await vi.waitFor(() => expect(mount.querySelectorAll('.ok-lint-block').length).toBe(1), {
      timeout: 5_000,
    });
    const block = mount.querySelector('.ok-lint-block') as HTMLElement;
    // The callout is body-appended rather than mounted under the editor, so a
    // leaked one from an earlier mount would be indistinguishable here.
    const callouts = document.querySelectorAll<HTMLElement>('.ok-lint-tooltip');
    expect(callouts).toHaveLength(1);
    const tooltip = callouts[0] as HTMLElement;

    block.dispatchEvent(pointer('pointerover'));
    expect(tooltip.hidden).toBe(false);

    // The pointer travels onto the callout so its Fix button stays reachable.
    // That grace suppresses the hide timer, so a dismissal has to unwind it:
    // once hidden the callout is no longer hit-testable, and an engine that
    // withholds the matching `pointerleave` would leave the grace latched.
    tooltip.dispatchEvent(new MouseEvent('pointerenter'));
    ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(tooltip.hidden).toBe(true);

    // Hover-to-read still works after the dismissal, and walking away from the
    // block must retire what it raised.
    block.dispatchEvent(pointer('pointerover'));
    expect(tooltip.hidden).toBe(false);
    ed.view.dom.dispatchEvent(pointer('pointerout', { relatedTarget: document.body }));
    await vi.waitFor(() => expect(tooltip.hidden).toBe(true), { timeout: 2_000 });
  });
});

describe('decoration recovery after a content-equal rebuild', () => {
  const DOC = 'lint-rebuild-doc';
  /** The hard tab trips MD010 — the same body-anchored rule the e2e fixtures use. */
  const BODY = '# Heading\n\nfirst paragraph\n\n\tindented with a hard tab\n';
  const ENABLED_CONFIG: LinterConfig = {
    enabled: true,
    plugins: {
      ...DEFAULT_LINTER_CONFIG.plugins,
      markdownlint: { enabled: true, rules: { default: true } },
    },
  };
  let editor: Editor | null = null;
  let host: HTMLElement | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ effective: ENABLED_CONFIG }),
    ) as unknown as typeof fetch;
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = new Editor({
      element: host,
      extensions: [
        ...coreExtensions,
        MarkdownLintDecorations.configure({ docName: DOC, getSource: () => BODY }),
      ],
      content: md.parse(BODY),
    });
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    host?.remove();
    host = null;
    globalThis.fetch = originalFetch;
  });

  const decoratedBlocks = () => host?.querySelectorAll('.ok-lint-block').length ?? 0;

  test('a content-equal full replace reschedules the pass instead of orphaning the squiggle', async () => {
    const ed = editor;
    if (!ed) throw new Error('editor not mounted');
    await vi.waitFor(() => expect(decoratedBlocks()).toBe(1), { timeout: 5_000 });
    // Drain any pass the mount-time transactions already debounced: a pending
    // timer would repaint after the replace below regardless of the reschedule
    // predicate, and this test exists to pin the predicate.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(decoratedBlocks()).toBe(1);

    // A server-side full-body replace whose body bytes are unchanged (e.g. an
    // agent write that only edits frontmatter) reaches this view as new nodes
    // carrying equal content: `doc.eq` reads it as "nothing changed", but the
    // replace's mapping still destroys the node decorations on the range.
    const state = ed.state;
    const rebuilt = state.schema.nodeFromJSON(md.parse(BODY));
    const before = state.doc;
    ed.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, rebuilt.content));
    expect(ed.state.doc.eq(before)).toBe(true);
    expect(ed.state.doc).not.toBe(before);
    expect(decoratedBlocks()).toBe(0);

    // The plugin must notice the step-bearing transaction and repaint from
    // source; under a content-equality reschedule predicate the squiggle
    // stays orphaned forever.
    await vi.waitFor(() => expect(decoratedBlocks()).toBe(1), { timeout: 5_000 });
  });
});
