import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Config } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { subscribeToOpenAskAiComposer } from '@/components/ask-ai-composer-events';
import { OUTLINE_NAV_EVENT, type OutlineNavDetail } from '@/components/OutlinePanel';
import { LINT_NAV_EVENT, type LintNavDetail } from '@/components/ProblemsPanel';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { evictCmEditor } from './editor-cache';
import type { LandingHandle } from './landing-controller';
import { applyRawMdxNavigation, SourceEditor } from './SourceEditor';
import {
  __resetScrollRestoreCoordination,
  registerLandingScrollOwner,
} from './scroll-restore-coordination';
import {
  clearPendingSourceNavigationsForTest,
  peekPendingSourceNavigation,
  rememberPendingSourceNavigation,
  type SelectionOffsetNavigation,
} from './source-editor-navigation';

/**
 * Override slot for the cross-mode landing start. Whether a landing starts is
 * the branch the replay effect's consume decision turns on, and neither answer
 * is reachable in jsdom (a landing needs a mounted WYSIWYG doc and a scroller
 * with real client rects). Unset by default, so every other test in this file
 * runs the real implementation.
 */
const landingOverride = vi.hoisted(() => ({
  start: null as (() => LandingHandle | null) | null,
}));

vi.mock('./mode-switch-landing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mode-switch-landing')>();
  return {
    ...actual,
    startSourceLanding: (params: Parameters<typeof actual.startSourceLanding>[0]) =>
      landingOverride.start ? landingOverride.start() : actual.startSourceLanding(params),
  };
});

const originalFetch = globalThis.fetch;
(globalThis as { Window?: typeof window.Window }).Window = window.Window;
Object.defineProperty(window.Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
});
Object.defineProperty(window.Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }),
});

const mountedDocNames = new Set<string>();

// Count open+focus requests reaching the BottomComposer subscriber path.
let composerOpenRequests = 0;
let unsubscribeComposer: (() => void) | null = null;

function makeConfigValue(wordWrap: boolean): ConfigContextValue {
  return {
    userBinding: null,
    userSynced: false,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: null,
    projectLocalConfig: null,
    projectSynced: false,
    projectLocalSynced: false,
    merged: { editor: { wordWrap } } as Config,
  };
}

function makeProvider(
  docName: string,
  content = '# heading\n\nbody',
): { provider: HocuspocusProvider; ytext: Y.Text } {
  const document = new Y.Doc();
  const ytext = document.getText('source');
  ytext.insert(0, content);
  const awareness = new Awareness(document);
  const provider = {
    document,
    awareness,
    configuration: { name: docName },
    destroy: () => {
      awareness.destroy();
      document.destroy();
    },
  } as unknown as HocuspocusProvider;
  mountedDocNames.add(docName);
  return { provider, ytext };
}

// `isSourceModeActive` is pinned true rather than exposed as a knob: the only
// behavior the false case drives is `applyRawMdxNavigation`'s stillInSourceMode
// bail, and the "raw-MDX replay mode re-check" suite below exercises that
// directly against the function — a component-level route to the same guard
// would be a second, slower path to an assertion already made.
function Harness({
  provider,
  ytext,
  wordWrap,
}: {
  provider: HocuspocusProvider;
  ytext: Y.Text;
  wordWrap: boolean;
}) {
  return (
    <ConfigContext value={makeConfigValue(wordWrap)}>
      <SourceEditor
        docName={provider.configuration.name ?? 'test-source'}
        ytext={ytext}
        provider={provider}
        isSourceModeActive
      />
    </ConfigContext>
  );
}

async function findCmContent(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector('.cm-content')).toBeTruthy();
  });
  return container.querySelector<HTMLElement>('.cm-content');
}

/** `@tiptap/core`'s `isMacOS()` reads `navigator.platform` at call time. */
function setPlatform(platform: string): void {
  Object.defineProperty(globalThis.navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('SourceEditor word-wrap preference wiring', () => {
  beforeEach(() => {
    composerOpenRequests = 0;
    unsubscribeComposer = subscribeToOpenAskAiComposer(() => {
      composerOpenRequests += 1;
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/pages') return Response.json({ pages: [] });
      if (url === '/api/documents') return Response.json({ documents: [] });
      if (url === '/api/tags') return Response.json({ tags: [] });
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    unsubscribeComposer?.();
    unsubscribeComposer = null;
    cleanup();
    for (const docName of mountedDocNames) {
      evictCmEditor(docName);
    }
    mountedDocNames.clear();
    globalThis.fetch = originalFetch;
  });

  test('applies editor.wordWrap to the source CodeMirror instance', async () => {
    const { provider, ytext } = makeProvider('source-word-wrap-off');
    const { container } = render(<Harness provider={provider} ytext={ytext} wordWrap={false} />);

    const content = await findCmContent(container);

    expect(content.classList.contains('cm-lineWrapping')).toBe(false);
  });

  test('hot-swaps source CodeMirror line wrapping without remounting', async () => {
    const { provider, ytext } = makeProvider('source-word-wrap-hot-swap');
    const { container, rerender } = render(
      <Harness provider={provider} ytext={ytext} wordWrap={true} />,
    );

    const content = await findCmContent(container);
    const cmEditor = container.querySelector('.cm-editor');
    expect(content.classList.contains('cm-lineWrapping')).toBe(true);

    rerender(<Harness provider={provider} ytext={ytext} wordWrap={false} />);

    await waitFor(() => {
      expect(content.classList.contains('cm-lineWrapping')).toBe(false);
    });
    expect(container.querySelector('.cm-editor')).toBe(cmEditor);
  });

  // ⇧⌘I is retired. It was mac-only and source-mode-only, it duplicated ⇧⌘L,
  // and despite being titled "Ask AI (from selection)" it never staged the
  // selection — it only opened the composer. Selection→AI is ⌘L now.
  test('Cmd+Shift+I no longer opens the Ask AI composer', async () => {
    setPlatform('MacIntel');
    const { provider, ytext } = makeProvider('source-edit-with-ai-retired');
    const { container } = render(<Harness provider={provider} ytext={ytext} wordWrap={true} />);

    const content = await findCmContent(container);
    const view = EditorView.findFromDOM(content);
    expect(view).toBeTruthy();
    view?.dispatch({ selection: EditorSelection.range(2, 9) });

    await act(async () => {
      content.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'I',
          code: 'KeyI',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(composerOpenRequests).toBe(0);
  });
});

describe('SourceEditor outline navigation', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/pages') return Response.json({ pages: [] });
      if (url === '/api/documents') return Response.json({ documents: [] });
      if (url === '/api/tags') return Response.json({ tags: [] });
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    for (const docName of mountedDocNames) {
      evictCmEditor(docName);
    }
    mountedDocNames.clear();
    globalThis.fetch = originalFetch;
  });

  async function dispatchOutlineNav(docName: string, index: number, slug: string): Promise<void> {
    const detail: OutlineNavDetail = { docName, index, slug, mode: 'source' };
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OUTLINE_NAV_EVENT, { detail }));
    });
  }

  test('only the source editor matching the navigation document moves its cursor', async () => {
    const first = makeProvider('source-outline-owner', '# First\n\n## First target');
    const second = makeProvider('source-outline-bystander', '# Second\n\n## Second target');
    const { container } = render(
      <>
        <Harness provider={first.provider} ytext={first.ytext} wordWrap={true} />
        <Harness provider={second.provider} ytext={second.ytext} wordWrap={true} />
      </>,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.cm-content')).toHaveLength(2);
    });
    const [firstContent, secondContent] = container.querySelectorAll<HTMLElement>('.cm-content');
    const firstView = EditorView.findFromDOM(firstContent);
    const secondView = EditorView.findFromDOM(secondContent);
    expect(firstView).toBeTruthy();
    expect(secondView).toBeTruthy();
    if (!firstView || !secondView) return;

    const secondSelectionBefore = secondView.state.selection.main.head;
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(OUTLINE_NAV_EVENT, {
          detail: {
            docName: 'source-outline-owner',
            index: 1,
            slug: 'first-target',
            mode: 'source',
          } satisfies OutlineNavDetail,
        }),
      );
    });

    expect(firstView.state.selection.main.head).toBe(firstView.state.doc.line(3).from);
    expect(secondView.state.selection.main.head).toBe(secondSelectionBefore);
  });

  test('skips a frontmatter region whose opening fence carries a trailing space', async () => {
    // `--- ` is one in-tolerance keystroke away from `---`. The outline list
    // comes from the server's extractHeadings (core fence contract — FM
    // stripped), so the client-side jump scan must skip the same FM region or
    // the YAML `#` comment is miscounted as the index-0 heading.
    const content = [
      '--- ',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---',
      '',
      '# Real Heading',
      '',
      'body',
    ].join('\n');
    const { provider, ytext } = makeProvider('source-outline-nav-fm-ws', content);
    const { container } = render(<Harness provider={provider} ytext={ytext} wordWrap={true} />);

    const cmContent = await findCmContent(container);
    const view = EditorView.findFromDOM(cmContent);
    expect(view).toBeTruthy();
    if (!view) return;

    await dispatchOutlineNav('source-outline-nav-fm-ws', 0, 'real-heading');

    const headingLine = view.state.doc.line(6);
    expect(headingLine.text).toBe('# Real Heading');
    expect(view.state.selection.main.head).toBe(headingLine.from);
  });

  test('skips a frontmatter region whose closing fence carries a trailing tab', async () => {
    const content = [
      '---',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---\t',
      '',
      '# Real Heading',
    ].join('\n');
    const { provider, ytext } = makeProvider('source-outline-nav-fm-close-ws', content);
    const { container } = render(<Harness provider={provider} ytext={ytext} wordWrap={true} />);

    const cmContent = await findCmContent(container);
    const view = EditorView.findFromDOM(cmContent);
    expect(view).toBeTruthy();
    if (!view) return;

    await dispatchOutlineNav('source-outline-nav-fm-close-ws', 0, 'real-heading');

    const headingLine = view.state.doc.line(6);
    expect(headingLine.text).toBe('# Real Heading');
    expect(view.state.selection.main.head).toBe(headingLine.from);
  });

  test('bare fences: jumps to the Nth heading after the FM region (regression control)', async () => {
    const content = [
      '---',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---',
      '',
      '# First',
      '',
      '## Second',
    ].join('\n');
    const { provider, ytext } = makeProvider('source-outline-nav-fm-bare', content);
    const { container } = render(<Harness provider={provider} ytext={ytext} wordWrap={true} />);

    const cmContent = await findCmContent(container);
    const view = EditorView.findFromDOM(cmContent);
    expect(view).toBeTruthy();
    if (!view) return;

    await dispatchOutlineNav('source-outline-nav-fm-bare', 1, 'second');

    const headingLine = view.state.doc.line(8);
    expect(headingLine.text).toBe('## Second');
    expect(view.state.selection.main.head).toBe(headingLine.from);
  });
});

describe('SourceEditor raw-MDX replay mode re-check', () => {
  interface FakeCmView {
    state: { doc: { length: number } };
    dispatch: (spec: unknown) => void;
    focus: () => void;
    dispatched: unknown[];
  }

  function fakeCmView(docLength = 100): FakeCmView {
    const dispatched: unknown[] = [];
    return {
      state: { doc: { length: docLength } },
      dispatch: (spec) => {
        dispatched.push(spec);
      },
      focus: () => {},
      dispatched,
    };
  }

  const nextFrame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

  const NAV_DOC = 'raw-mdx-doc';

  beforeEach(() => {
    __resetScrollRestoreCoordination();
  });

  afterEach(() => {
    __resetScrollRestoreCoordination();
  });

  test('does not dispatch when the editor left source mode before the frame ran', async () => {
    const view = fakeCmView();
    applyRawMdxNavigation(view as unknown as EditorView, { offset: 42 }, () => false, NAV_DOC);
    await nextFrame();
    expect(view.dispatched).toHaveLength(0);
  });

  test('dispatches the navigation when still in source mode', async () => {
    const view = fakeCmView();
    applyRawMdxNavigation(view as unknown as EditorView, { offset: 42 }, () => true, NAV_DOC);
    await nextFrame();
    expect(view.dispatched).toHaveLength(1);
  });

  test('supersedes a position-preserving landing still holding the scroller', async () => {
    const supersede = vi.fn();
    registerLandingScrollOwner(NAV_DOC, { yieldsToNavigation: true, supersede });
    const view = fakeCmView();

    applyRawMdxNavigation(view as unknown as EditorView, { offset: 42 }, () => true, NAV_DOC);
    await nextFrame();

    expect(supersede).toHaveBeenCalledTimes(1);
    expect(view.dispatched).toHaveLength(1);
  });

  test('stands down while a landing that is itself a navigation owns the scroller', async () => {
    registerLandingScrollOwner(NAV_DOC, { yieldsToNavigation: false, supersede: vi.fn() });
    const view = fakeCmView();

    applyRawMdxNavigation(view as unknown as EditorView, { offset: 42 }, () => true, NAV_DOC);
    await nextFrame();

    expect(view.dispatched).toHaveLength(0);
  });
});

/**
 * The queued cross-mode jump is consume-once, so consuming it before knowing a
 * landing actually started throws it away: `startSourceLanding` declines when
 * the WYSIWYG doc it grades against was never mounted (the deferred-mount path
 * a large document takes), and the user's jump target would be gone even though
 * the entry's TTL still allows a later replay.
 */
describe('SourceEditor cross-mode landing replay', () => {
  const NAVIGATION: SelectionOffsetNavigation = {
    kind: 'selection-offset',
    intent: 'jump',
    anchor: { blockIndex: 0, kind: 'heading', content: 'heading' },
  };

  beforeEach(() => {
    clearPendingSourceNavigationsForTest();
    globalThis.fetch = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
  });

  afterEach(() => {
    landingOverride.start = null;
    clearPendingSourceNavigationsForTest();
    cleanup();
    for (const docName of mountedDocNames) evictCmEditor(docName);
    mountedDocNames.clear();
    globalThis.fetch = originalFetch;
  });

  /** Mount source mode over a banked jump and let the deferred replay run. */
  async function mountWithQueuedJump(docName: string): Promise<void> {
    const { provider, ytext } = makeProvider(docName);
    rememberPendingSourceNavigation(docName, NAVIGATION);
    const { container } = render(<Harness provider={provider} ytext={ytext} wordWrap={true} />);
    await findCmContent(container);
    // The replay is deferred to a microtask so a StrictMode mount/unmount cycle
    // finishes first; flush it before reading the store.
    await act(async () => {});
  }

  test('keeps the jump banked when no landing could start', async () => {
    landingOverride.start = () => null;

    await mountWithQueuedJump('source-landing-declined');

    expect(peekPendingSourceNavigation('source-landing-declined')).toEqual(NAVIGATION);
  });

  test('consumes the jump once a landing owns it', async () => {
    landingOverride.start = () => ({ cancel: () => {} });

    await mountWithQueuedJump('source-landing-started');

    expect(peekPendingSourceNavigation('source-landing-started')).toBeNull();
  });
});

/**
 * The Problems row banks its intent and then dispatches a live event, so
 * whichever editor is visible consumes the event and clears the bank. A click
 * the scroller refuses moved nothing, so clearing on it spends the intent on a
 * jump that never happened. The WYSIWYG half of this seam gates its clear on
 * the same answer.
 */
describe('SourceEditor Problems-row navigation', () => {
  const detailFor = (docName: string): LintNavDetail => ({ docName, line: 3, column: 1 });

  beforeEach(() => {
    __resetScrollRestoreCoordination();
    clearPendingSourceNavigationsForTest();
    globalThis.fetch = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
  });

  afterEach(() => {
    __resetScrollRestoreCoordination();
    clearPendingSourceNavigationsForTest();
    cleanup();
    for (const docName of mountedDocNames) evictCmEditor(docName);
    mountedDocNames.clear();
    globalThis.fetch = originalFetch;
  });

  /**
   * Mount source mode, then bank and click in the panel's own order. Banking
   * before the mount would be replayed and consumed by the mount-time effect,
   * which is a different path from the live click under test.
   */
  async function clickProblemsRow(docName: string): Promise<void> {
    const { provider, ytext } = makeProvider(docName, '# heading\n\nbody\n\nmore body');
    const { container } = render(<Harness provider={provider} ytext={ytext} wordWrap={true} />);
    await findCmContent(container);
    rememberPendingSourceNavigation(docName, { kind: 'lint', detail: detailFor(docName) });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(LINT_NAV_EVENT, { detail: detailFor(docName) }));
    });
  }

  test('keeps the banked intent when a landing refuses the scroller', async () => {
    const docName = 'source-problems-row-refused';
    // A landing that is itself an explicit navigation keeps the scroller: it has
    // already placed the caret, so this click stands down whole.
    registerLandingScrollOwner(docName, { yieldsToNavigation: false, supersede: () => {} });

    await clickProblemsRow(docName);

    expect(peekPendingSourceNavigation(docName)).toEqual({
      kind: 'lint',
      detail: detailFor(docName),
    });
  });

  test('consumes it once the jump has run', async () => {
    const docName = 'source-problems-row-granted';

    await clickProblemsRow(docName);

    expect(peekPendingSourceNavigation(docName)).toBeNull();
  });
});
