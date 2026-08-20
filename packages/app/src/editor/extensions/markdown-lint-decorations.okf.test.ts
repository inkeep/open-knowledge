// @vitest-environment jsdom
/**
 * OKF frontmatter diagnostics through the WYSIWYG anchoring seams — the block
 * decoration mapping and the Problems-row navigation. The sibling test file
 * covers both seams for the built-in `frontmatter` plugin; the OKF plugin is a
 * second producer of frontmatter diagnostics, and they are anchorless for the
 * same reason: the validator anchors a missing-`required` violation to the
 * region's opening fence, which on a doc with NO frontmatter is line 1 — the
 * first line of body text. Anchoring by line would squiggle (and navigate to) a
 * correct first block on exactly the docs where the schema error matters most.
 *
 * OKF body rules carry no frontmatter scope and must keep their body anchor —
 * the discriminator is the diagnostic's scope metadata, not the producing
 * plugin id.
 *
 * Diagnostics come from the REAL `lintDocument` pass over the REAL OKF
 * registry, not hand-built stand-ins, so the tests fail if the producer's
 * anchoring or metadata changes shape.
 */

import {
  sharedExtensions as coreExtensions,
  DEFAULT_LINTER_CONFIG,
  type LintDiagnostic,
  type LinterConfig,
  lintDocument,
  MarkdownManager,
} from '@inkeep/open-knowledge-core';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LINT_NAV_EVENT, type LintNavDetail } from '@/components/ProblemsPanel';
import { __resetScrollRestoreCoordination } from '../scroll-restore-coordination.ts';
import { MarkdownLintDecorations, mapDiagnosticsToBlocks } from './markdown-lint-decorations.ts';

const md = new MarkdownManager({ extensions: coreExtensions });

// A concept-scoped doc name (anything but a reserved `index`/`log` filename).
const DOC = 'notes/lint-nav-okf';

const okfConfig: LinterConfig = {
  enabled: true,
  plugins: {
    markdownlint: { enabled: false, rules: {} },
    frontmatter: { enabled: true, schemas: [] },
    okf: { enabled: true },
  },
};

// No frontmatter region at all, so the OKF missing-`type` violation anchors to
// line 1 — body text. Block 1 carries a wiki-link for the `no-wiki-links` body
// rule, which MUST keep its anchor.
//   1: # Heading
//   2:
//   3: See [[Wiki Target]] here.
//   4:
//   5: Second paragraph.
const BODY = '# Heading\n\nSee [[Wiki Target]] here.\n\nSecond paragraph.\n';

async function realOkfDiagnostics(): Promise<{
  frontmatterRequired: LintDiagnostic;
  noWikiLinks: LintDiagnostic;
}> {
  const diagnostics = await lintDocument(BODY, okfConfig, DOC);
  const frontmatterRequired = diagnostics.find(
    (d) => d.source === 'okf' && d.code === 'frontmatter-required',
  );
  const noWikiLinks = diagnostics.find((d) => d.source === 'okf' && d.code === 'no-wiki-links');
  if (!frontmatterRequired || !noWikiLinks) {
    throw new Error('expected the real OKF pass to produce both diagnostics');
  }
  return { frontmatterRequired, noWikiLinks };
}

describe('mapDiagnosticsToBlocks with real OKF diagnostics', () => {
  test('skips an OKF frontmatter violation on a doc with NO frontmatter region', async () => {
    const { frontmatterRequired } = await realOkfDiagnostics();
    // The violation carries frontmatter scope and anchors to body line 1.
    expect(frontmatterRequired.frontmatterScope).toBe('missing');
    expect(frontmatterRequired.range.start.line).toBe(0);

    const byBlock = mapDiagnosticsToBlocks(BODY, [frontmatterRequired], md);
    expect(byBlock.size).toBe(0);
  });

  test('still maps an OKF body-rule violation to its block', async () => {
    const { noWikiLinks } = await realOkfDiagnostics();
    const byBlock = mapDiagnosticsToBlocks(BODY, [noWikiLinks], md);
    // Line 3 is block 1 (the paragraph carrying the wiki-link).
    expect([...byBlock.keys()]).toEqual([1]);
  });

  test('drops only the frontmatter-scoped diagnostic from a mixed OKF set', async () => {
    const { frontmatterRequired, noWikiLinks } = await realOkfDiagnostics();
    const byBlock = mapDiagnosticsToBlocks(BODY, [frontmatterRequired, noWikiLinks], md);
    expect([...byBlock.keys()]).toEqual([1]);
    expect(byBlock.get(1)).toHaveLength(1);
    expect(byBlock.get(1)?.[0]?.code).toBe('no-wiki-links');
  });
});

describe('Problems-row navigation for OKF diagnostics', () => {
  let editor: Editor | null = null;
  let host: HTMLElement | null = null;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: PropertyDescriptor | undefined;
  let originalFetch: typeof globalThis.fetch;

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
    // jsdom has no layout: `offsetParent` is the plugin's "am I the visible
    // editor" gate, installed manually like the sibling suite does.
    Object.defineProperty(mounted.view.dom, 'offsetParent', { value: host, configurable: true });
    return mounted;
  }

  /** Dispatch the row-click event with the detail the Problems panel derives from `diagnostic`. */
  function clickProblemsRow(diagnostic: LintDiagnostic): void {
    const detail: LintNavDetail & Pick<LintDiagnostic, 'frontmatterScope' | 'frontmatterProperty'> =
      {
        docName: DOC,
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        source: diagnostic.source,
        ...(diagnostic.frontmatterScope === undefined
          ? {}
          : { frontmatterScope: diagnostic.frontmatterScope }),
        ...(diagnostic.frontmatterProperty === undefined
          ? {}
          : { frontmatterProperty: diagnostic.frontmatterProperty }),
      };
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

  test('declines an OKF frontmatter row rather than selecting the first body block', async () => {
    // The missing-`type` violation reports on line 1, which with no
    // frontmatter region is the heading — nothing is wrong with it; the
    // property panel owns this error.
    const { frontmatterRequired } = await realOkfDiagnostics();
    const before = editor?.state.selection.from;

    clickProblemsRow(frontmatterRequired);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(editor?.state.selection.from).toBe(before);
  });

  test('still navigates for an OKF body-rule row', async () => {
    const { noWikiLinks } = await realOkfDiagnostics();

    clickProblemsRow(noWikiLinks);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // The wiki-link renders as its own inline node, so the paragraph's
    // textContent carries only the surrounding prose.
    const { $from } = editor?.state.selection ?? {};
    expect($from?.parent.textContent).toContain('See');
  });
});
