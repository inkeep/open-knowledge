import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { sharedExtensions } from '@inkeep/open-knowledge-core/extensions/shared';
import { tags } from '@lezer/highlight';
import { FileTree } from '@pierre/trees';
import { act, cleanup, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import axe from 'axe-core';
import { ThemeProvider } from 'next-themes';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import * as Y from 'yjs';
import { ActivityPanelDiffView } from '@/components/ActivityPanelDiffView';
import { ConflictView } from '@/components/ConflictView';
import { FileTreeEmptyState } from '@/components/FileTree';
import { createFileTreeStyle, FILE_TREE_DENSITY_OPTIONS } from '@/components/file-tree-density';
import { OK_FILE_TREE_READONLY_UNSAFE_CSS } from '@/components/file-tree-shared';
import { MermaidDocEditor } from '@/components/MermaidDocEditor';
import { ColorThemePicker } from '@/components/settings/ColorThemePicker';
import { SettingsDialogShell } from '@/components/settings/SettingsDialogShell';
import { TerminalPanel } from '@/components/TerminalPanel';
import { TextDocEditor } from '@/components/TextDocEditor';
import { TextViewer } from '@/components/TextViewer';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CodeMirrorPropInput } from '@/editor/components/CodeMirrorPropInput';
import { CodePreviewEditModal } from '@/editor/components/CodePreviewEditModal';
import { DocumentProvider } from '@/editor/DocumentContext';
import { evictCmEditor } from '@/editor/editor-cache';
import { okSyntaxHighlight } from '@/editor/extensions/cm-theme';
import { CodeBlockFidelity } from '@/editor/extensions/code-block';
import { RawMdxFallback } from '@/editor/extensions/raw-mdx-fallback';
import { SourceEditor } from '@/editor/SourceEditor';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { stubApiRoutes } from './api-routes.test-helper';
import { renderWithI18n } from './render-with-i18n.test-helper';
import { textLeaves, textMeasurement } from './theme-contrast.test-helper';
import { measuredBackgrounds as BACKGROUNDS } from './theme-text-backgrounds.test-helper';

type ThemeCase = { id: string; mode: 'light' | 'dark' };
const THEMES: ThemeCase[] = [
  { id: 'default-light', mode: 'light' },
  { id: 'default-dark', mode: 'dark' },
];
const CODE =
  '// note\nconst retries = 3;\nconst config = { enabled: true };\nconst ready = "ready";\nfunction plan(value) { return true; }\n';
const MARKDOWN = `# Release plan\n\n> quoted note\n\n[themed preview](https://example.test)\n\n\`\`\`javascript\n${CODE}\`\`\`\n`;
const CONFIG: ConfigContextValue = {
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
  merged: null,
};
const disposers: (() => void)[] = [];
let stylesheet: HTMLStyleElement;
const AXE_INCOMPLETE_DISPOSITIONS: Record<string, string> = {
  nonBmp: 'Axe cannot evaluate non-text fold glyphs; text leaves are measured separately.',
  bgOverlap: 'Axe cannot infer xterm layered backgrounds; ordinary cells have pixel measurements.',
};

beforeAll(async () => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = await commands.buildAppStylesheet();
  document.head.append(stylesheet);
});

beforeEach(() => {
  stubApiRoutes({
    '/api/audit': () => Response.json({ entries: [], total: 0 }),
    '/api/pages': () => Response.json({ pages: [] }),
    '/api/documents': () => Response.json({ documents: [] }),
    '/api/tags': () => Response.json({ tags: [] }),
    '/api/lint/config': () => new Response(null, { status: 404 }),
  });
});

afterEach(async () => {
  const audit = await axe.run(document.body, { runOnly: ['color-contrast'] });
  expect.soft(audit.violations).toEqual([]);
  const undisposedIncomplete = audit.incomplete
    .flatMap((result) => result.nodes.flatMap((node) => node.any))
    .filter((check) => {
      const messageKey =
        check.data && typeof check.data === 'object' && 'messageKey' in check.data
          ? check.data.messageKey
          : null;
      return typeof messageKey !== 'string' || !(messageKey in AXE_INCOMPLETE_DISPOSITIONS);
    });
  expect
    .soft(undisposedIncomplete, 'axe incomplete results need an explicit disposition')
    .toEqual([]);
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  delete document.documentElement.dataset.colorTheme;
  document.documentElement.classList.remove('dark');
  document.documentElement.style.removeProperty('color-scheme');
  vi.unstubAllGlobals();
});
afterAll(() => stylesheet.remove());

function applyTheme(theme: ThemeCase) {
  document.documentElement.classList.toggle('dark', theme.mode === 'dark');
  document.documentElement.style.colorScheme = theme.mode;
  delete document.documentElement.dataset.colorTheme;
}

function mount(theme: ThemeCase, ui: ReactElement) {
  applyTheme(theme);
  return renderWithI18n(
    <ThemeProvider
      forcedTheme={theme.mode}
      defaultTheme={theme.mode}
      storageKey={`contrast-mode-${theme.id}`}
      attribute="class"
      enableSystem={false}
    >
      <ConfigContext value={CONFIG}>
        <div
          style={{
            width: 900,
            minHeight: 320,
            background: 'var(--background)',
            color: 'var(--foreground)',
          }}
        >
          {ui}
        </div>
      </ConfigContext>
    </ThemeProvider>,
  );
}

function providerWithText(name: string, text: string) {
  const document = new Y.Doc();
  document.getText('source').insert(0, text);
  const provider = new HocuspocusProvider({
    url: 'ws://127.0.0.1:1',
    name,
    document,
    autoConnect: false,
  });
  disposers.push(() => {
    provider.destroy();
    document.destroy();
  });
  return provider;
}

function checkReadings(
  theme: ThemeCase,
  surface: string,
  readings: ReturnType<typeof textMeasurement>[],
) {
  const quantize = (value: number) => Math.round(value * 255) / 255;
  expect(readings.length, `${surface} rendered text`).toBeGreaterThan(0);
  const backgrounds = [
    ...new Set(readings.map((reading) => JSON.stringify(reading.background.map(quantize)))),
  ]
    .sort()
    .map((value: string) => JSON.parse(value) as number[]);
  const expected = [
    ...new Set(
      (BACKGROUNDS[`${theme.id}/${surface}`] ?? []).map((background) =>
        JSON.stringify(background.map(quantize)),
      ),
    ),
  ]
    .sort()
    .map((value: string) => JSON.parse(value) as number[]);
  expect.soft(backgrounds, `${theme.id} ${surface} preserves its backgrounds`).toEqual(expected);
  for (const reading of readings) {
    expect
      .soft(
        reading.ratio,
        `${theme.id} ${surface} ${reading.text}: ${reading.foreground} on ${JSON.stringify(reading.background)}`,
      )
      .toBeGreaterThanOrEqual(4.5);
  }
  return readings;
}

function checkText(theme: ThemeCase, surface: string, elements: Element[], overlay?: Element) {
  return checkReadings(
    theme,
    surface,
    elements.map((element) => textMeasurement(element, overlay)),
  );
}

async function cmView(container: Element): Promise<EditorView> {
  return waitFor(() => {
    const content = container.querySelector<HTMLElement>('.cm-content');
    expect(content).toBeTruthy();
    if (!content) throw new Error('CodeMirror content did not render');
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error('CodeMirror view unavailable');
    return view;
  });
}

async function settleCodeMirror(view: EditorView): Promise<void> {
  await new Promise<void>((resolve) =>
    view.requestMeasure({ read: () => undefined, write: () => queueMicrotask(resolve) }),
  );
}

async function highlighted(container: HTMLElement, text: string, semanticClass?: string | null) {
  return waitFor(() => {
    const leaf = textLeaves(container).find(
      (element) =>
        element.tagName === 'SPAN' &&
        element.textContent === text &&
        (!semanticClass ||
          semanticClass.split(' ').every((name) => element.classList.contains(name))),
    );
    expect(leaf, `highlighted ${text}`).toBeTruthy();
    if (!leaf) throw new Error(`Missing rendered ${text}`);
    return leaf;
  });
}

function makeRichEditor() {
  const editor = new Editor({
    extensions: sharedExtensions.map((extension) =>
      extension.name === 'codeBlock'
        ? CodeBlockFidelity
        : extension.name === 'rawMdxFallback'
          ? RawMdxFallback
          : extension,
    ),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Release plan' }] },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted note' }] }],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'javascript' },
          content: [{ type: 'text', text: CODE }],
        },
        {
          type: 'rawMdxFallback',
          attrs: { reason: 'Parse failed' },
          content: [{ type: 'text', text: '<Foo>broken</Bar>' }],
        },
      ],
    },
  });
  disposers.push(() => editor.destroy());
  return editor;
}

function richEditorPortal(editor: Editor) {
  const target = document.createElement('div');
  target.className = 'tiptap-editor-portal-content';
  const content = createPortal(
    // oxlint-disable-next-line ok/no-unportaled-editor-content -- This fixture gives each editor an exclusive portal target.
    <EditorContent editor={editor} />,
    target,
  );
  return (
    <>
      <div
        className="tiptap-editor"
        ref={(element) => {
          element?.append(target);
        }}
      />
      {content}
    </>
  );
}

function terminalBridge(): OkDesktopBridge {
  const terminal = {
    adopt: async () => ({
      ok: true as const,
      replay: 'Plain text\r\n\x1b[90mBright black\x1b[0m\r\n\x1b[31mRed text\x1b[0m\r\n',
    }),
    input: () => {},
    resize: () => {},
    drain: () => {},
    kill: async () => {},
    onData: () => () => {},
    onExit: () => () => {},
    onNotice: () => () => {},
  };
  return {
    terminal,
    config: { e2eSmoke: true, projectPath: '/contrast-fixture' },
    platform: 'darwin',
  } as unknown as OkDesktopBridge;
}

describe('rendered theme text contrast', () => {
  test('measurement oracle resolves reference sRGB and Oklch pairs', () => {
    const fixtures = [
      ['#ffffff', '#000000', 21],
      ['#3e4b59', '#131721', 2.0094635187573844],
      ['oklch(0.553 0.013 58.071)', 'oklch(0.97 0 0)', 4.407529],
    ] as const;
    for (const [foreground, background, expected] of fixtures) {
      const element = document.createElement('span');
      element.textContent = 'reference';
      element.style.color = foreground;
      element.style.backgroundColor = background;
      document.body.append(element);
      try {
        const reading = textMeasurement(element);
        expect(reading.ratio).toBeCloseTo(expected, 5);
      } finally {
        element.remove();
      }
    }
  });
  for (const theme of THEMES) {
    test(`${theme.id} source text stays readable through active search and selection states`, async () => {
      const name = `contrast-${theme.id}.md`;
      const provider = providerWithText(name, MARKDOWN);
      disposers.push(() => evictCmEditor(name));
      const { container } = mount(
        theme,
        <SourceEditor
          docName={name}
          ytext={provider.document.getText('source')}
          provider={provider}
          isSourceModeActive={true}
        />,
      );
      const view = await cmView(container);
      await waitFor(() =>
        expect(view.state.facet(EditorView.darkTheme)).toBe(theme.mode === 'dark'),
      );
      await highlighted(container, '// note', okSyntaxHighlight.style([tags.comment]));
      await settleCodeMirror(view);
      checkText(theme, 'source', textLeaves(view.contentDOM));
      const audit = await axe.run(view.contentDOM, { runOnly: ['color-contrast'] });
      expect.soft(audit.violations, `${theme.id} source contrast audit`).toEqual([]);
      const start = MARKDOWN.indexOf('// note');
      await act(async () => {
        view.dispatch({ selection: { anchor: start } });
        view.focus();
      });
      await waitFor(() =>
        expect(container.querySelector('.cm-activeLine')?.textContent).toContain('// note'),
      );
      await settleCodeMirror(view);
      checkText(theme, 'source-active', textLeaves(view.contentDOM));
      checkText(
        theme,
        'source-gutter',
        textLeaves(view.dom.querySelector('.cm-gutters') as Element).filter(
          (element) => !element.closest('[style*="visibility: hidden"]'),
        ),
      );
      await act(async () => {
        openSearchPanel(view);
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'note' })) });
        findNext(view);
      });
      await waitFor(() => {
        expect(container.querySelectorAll('.cm-searchMatch').length).toBeGreaterThan(0);
        const searchInput = view.dom.querySelector('.cm-search input[main-field]');
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
        expect(view.hasFocus).toBe(false);
        expect(view.dom.matches('.cm-focused')).toBe(false);
      });
      await settleCodeMirror(view);
      for (const element of textLeaves(view.contentDOM)) {
        expect(textMeasurement(element).ratio, `${theme.id} search match`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      await act(async () => {
        closeSearchPanel(view);
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
      });
    });

    test(`${theme.id} rich code prose and raw MDX text are readable`, async () => {
      const editor = makeRichEditor();
      const { container } = mount(theme, richEditorPortal(editor));
      await highlighted(container, '// note');
      await waitFor(() =>
        expect(container.querySelector('.raw-mdx-fallback-cm .cm-line')).toBeTruthy(),
      );
      await settleCodeMirror(await cmView(container));
      const rich = container.querySelector('.ProseMirror');
      if (!rich) throw new Error('Rich editor did not mount');
      checkText(
        theme,
        'rich-and-raw-mdx',
        textLeaves(rich).filter((element) => !element.closest('button')),
      );
    });

    test(`${theme.id} markdown in the text viewer keeps its structure styling`, async () => {
      const { container } = mount(
        theme,
        <section style={{ height: 160 }}>
          <TextViewer
            fileName="SKILL.md"
            extension=".md"
            loadText={async () => ({
              ok: true,
              text: '# Release plan\n\n*gently*\n\n**care**\n\n[the guide](https://example.test)\n',
            })}
          />
        </section>,
      );
      const view = await cmView(container);
      const leaf = (text: string) =>
        waitFor(() => {
          const element = textLeaves(view.contentDOM).find(
            (candidate) => candidate.textContent?.trim() === text,
          );
          expect(element, `rendered ${text}`).toBeTruthy();
          return element as Element;
        });
      const heading = await leaf('Release plan');
      const emphasis = await leaf('gently');
      const strong = await leaf('care');
      const link = await leaf('the guide');
      await settleCodeMirror(view);
      expect(Number(getComputedStyle(heading).fontWeight)).toBeGreaterThanOrEqual(700);
      expect(getComputedStyle(emphasis).fontStyle).toBe('italic');
      expect(Number(getComputedStyle(strong).fontWeight)).toBeGreaterThanOrEqual(700);
      expect(getComputedStyle(link).textDecorationLine).toContain('underline');
      for (const element of textLeaves(view.contentDOM))
        expect
          .soft(
            textMeasurement(element).ratio,
            `${theme.id} viewer markdown ${element.textContent}`,
          )
          .toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme.id} text document Mermaid source viewer and property text are readable`, async () => {
      const textProvider = providerWithText(`contrast-${theme.id}.js`, CODE);
      const mermaidProvider = providerWithText(
        `contrast-${theme.id}.mmd`,
        '%% note\ngraph TD\nA[Ready] --> B[Ship]\n',
      );
      const { container } = mount(
        theme,
        <>
          <section data-contrast="text-doc" style={{ height: 160 }}>
            <TextDocEditor docName={`contrast-${theme.id}.js`} provider={textProvider} />
          </section>
          <section data-contrast="mermaid" style={{ height: 160 }}>
            <MermaidDocEditor
              docName={`contrast-${theme.id}.mmd`}
              provider={mermaidProvider}
              isSourceMode={true}
            />
          </section>
          <section data-contrast="viewer" style={{ height: 160 }}>
            <TextViewer
              fileName="view.js"
              extension=".js"
              loadText={async () => ({ ok: true, text: CODE })}
            />
          </section>
          <section data-contrast="property">
            <CodeMirrorPropInput value={CODE} language="javascript" onChange={() => {}} />
          </section>
        </>,
      );
      await waitFor(() => expect(container.querySelectorAll('.cm-editor').length).toBe(4));
      for (const surface of ['text-doc', 'mermaid', 'viewer', 'property']) {
        const section = container.querySelector(`[data-contrast="${surface}"]`);
        if (!section) throw new Error(`Missing ${surface}`);
        await waitFor(() =>
          expect(section.querySelectorAll('.cm-line span').length).toBeGreaterThan(0),
        );
        await settleCodeMirror(await cmView(section));
        checkText(theme, surface, textLeaves(section));
      }
    });

    test(`${theme.id} file tree hover text is readable`, async () => {
      const { container } = mount(theme, <div data-contrast="tree" style={{ height: 200 }} />);
      const wrapper = container.querySelector('[data-contrast="tree"]') as HTMLElement;
      const tree = new FileTree({
        ...FILE_TREE_DENSITY_OPTIONS,
        unsafeCSS: OK_FILE_TREE_READONLY_UNSAFE_CSS,
        paths: ['note.md'],
        initialExpansion: 'open',
      });
      disposers.push(() => tree.cleanUp());
      tree.render({ containerWrapper: wrapper });
      const host = tree.getFileTreeContainer();
      if (!host) throw new Error('Tree did not mount');
      for (const [key, value] of Object.entries(createFileTreeStyle(theme.mode)))
        host.style.setProperty(key, String(value));
      const root = host.shadowRoot;
      if (!root) throw new Error('Tree shadow root missing');
      const label = await waitFor(() => {
        const element = root.querySelector('[role="treeitem"]');
        expect(element).toBeTruthy();
        if (!element) throw new Error('Tree label did not render');
        return element;
      });
      await page.elementLocator(label).hover();
      checkText(theme, 'tree-hover', textLeaves(root));
      await page.elementLocator(label).click();
      await waitFor(() => expect(root.querySelector('[aria-selected="true"]')).toBeTruthy());
      for (const element of textLeaves(root))
        expect(textMeasurement(element).ratio).toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme.id} empty file tree text is readable`, async () => {
      const { container } = mount(
        theme,
        <FileTreeEmptyState
          active={false}
          onDragOver={() => {}}
          onDragLeave={() => {}}
          onDrop={() => {}}
          onCreate={() => {}}
        />,
      );
      await waitFor(() => expect(container.textContent).toContain('No files yet.'));
      const empty = container.querySelector('.file-tree-empty-text');
      expect(empty).not.toBeNull();
      if (!empty) throw new Error('Empty file tree did not render');
      expect(textMeasurement(empty).ratio).toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme.id} changed diff words and gutters are readable`, async () => {
      const { container } = mount(
        theme,
        <ActivityPanelDiffView
          before={'context line\nold value\nlast line\n'}
          after={'context line\nnew value\nlast line\n'}
          cacheKey={`contrast-${theme.id}`}
        />,
      );
      const root = await waitFor(() => {
        const root = container.querySelector('diffs-container')?.shadowRoot;
        expect(root?.querySelector('[data-line]')).toBeTruthy();
        if (!root) throw new Error('Diff did not render');
        return root;
      });
      checkText(theme, 'diff', textLeaves(root));
    });

    test(`${theme.id} code modal text and gutters are readable`, async () => {
      const { getByRole } = mount(
        theme,
        <CodePreviewEditModal
          open={true}
          onOpenChange={() => {}}
          initialValue={CODE}
          language="javascript"
          title="Code fixture"
          onSave={() => {}}
        />,
      );
      const dialog = getByRole('dialog');
      await Promise.all(
        dialog.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
      await highlighted(dialog, '// note');
      const editor = dialog.querySelector('.ok-codepreview-cm');
      if (!editor) throw new Error('Code modal did not render');
      await settleCodeMirror(await cmView(editor));
      checkText(theme, 'code-modal', textLeaves(editor));
    });

    test(`${theme.id} syntax highlighted conflict text is readable`, async () => {
      const { container } = mount(
        theme,
        <ConflictView
          fileName="plan.js"
          base={CODE}
          ours={CODE.replace('"ready"', '"ours"')}
          theirs={CODE.replace('"ready"', '"theirs"')}
          onResolve={() => {}}
        />,
      );
      const root = await waitFor(() => {
        const root = container.querySelector('diffs-container')?.shadowRoot;
        expect(root?.querySelector('[data-line] span')).toBeTruthy();
        if (!root) throw new Error('Conflict did not render');
        return root;
      });
      checkText(theme, 'conflict-syntax', textLeaves(root));
    });

    test(`${theme.id} theme picker text and identifying icons have contrast`, async () => {
      const { container } = mount(
        theme,
        <ColorThemePicker
          selection={{ light: 'default', dark: 'default' }}
          onAssign={() => {}}
          slotMode={theme.mode}
          aria-label="Color theme"
        />,
      );
      const leaves = textLeaves(container);
      const icons = Array.from(container.querySelectorAll('button svg'));
      expect(leaves.length).toBeGreaterThan(0);
      expect(icons.length).toBeGreaterThan(0);
      expect(container.querySelectorAll('[data-state="off"] svg').length).toBeGreaterThan(0);
      for (const element of leaves)
        expect(textMeasurement(element).ratio).toBeGreaterThanOrEqual(4.5);
      for (const icon of icons) expect(textMeasurement(icon).ratio).toBeGreaterThanOrEqual(3);
      const toggle = container.querySelector<HTMLElement>('button[data-state="off"]');
      if (!toggle) throw new Error('Unpressed slot toggle did not render');
      const probe = document.createElement('span');
      probe.style.color = 'var(--foreground)';
      container.append(probe);
      const foreground = getComputedStyle(probe).color;
      probe.remove();
      expect(getComputedStyle(toggle).color).not.toBe(foreground);
      await page.elementLocator(toggle).hover();
      await waitFor(() => expect(getComputedStyle(toggle).color).toBe(foreground));
    });

    test(`${theme.id} keyboard hint chips are readable`, async () => {
      const { container } = mount(
        theme,
        <div>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </div>,
      );
      const chips = Array.from(container.querySelectorAll('[data-slot="kbd"]'));
      expect(chips.length).toBe(2);
      for (const chip of chips)
        expect(textMeasurement(chip).ratio, chip.textContent ?? '').toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme.id} keyboard hint chips inside an open tooltip are readable`, async () => {
      mount(
        theme,
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>Search</TooltipTrigger>
            <TooltipContent>
              Search
              <Kbd>Ctrl K</Kbd>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );
      const chip = await waitFor(() => {
        const element = document.body.querySelector(
          '[data-slot="tooltip-content"] [data-slot="kbd"]',
        );
        expect(element).not.toBeNull();
        return element as HTMLElement;
      });
      const content = chip.closest('[data-slot="tooltip-content"]');
      if (!content) throw new Error('Tooltip content did not render');
      await Promise.all(
        content.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
      expect(textMeasurement(chip).ratio, chip.textContent ?? '').toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme.id} settings navigation group titles are readable`, async () => {
      mount(
        theme,
        <DocumentProvider>
          <SettingsDialogShell open onOpenChange={() => {}} />
        </DocumentProvider>,
      );
      const titles = await waitFor(() => {
        const elements = Array.from(
          document.body.querySelectorAll<HTMLElement>('.settings-sidebar-group-title'),
        );
        expect(elements.length).toBeGreaterThan(0);
        return elements;
      });
      expect(titles[0]?.closest('[data-slot="dialog-content"]')).toBeTruthy();
      const readings = await waitFor(() => titles.map((title) => textMeasurement(title)));
      for (const reading of readings) {
        expect(
          reading.ratio,
          `${reading.text}: ${reading.foreground} on ${reading.background.join(', ')}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    test(`${theme.id} terminal ordinary cells are readable`, async () => {
      const { container } = mount(
        theme,
        <div style={{ height: 280 }}>
          <TerminalPanel bridge={terminalBridge()} adoptPtyId="contrast-terminal" />
        </div>,
      );
      await waitFor(() =>
        expect(container.querySelector('.xterm-rows')?.textContent).toContain('Red text'),
      );
      const rows = container.querySelector('.xterm-rows');
      if (!rows) throw new Error('Terminal did not render');
      checkText(theme, 'terminal', textLeaves(rows));
    });
  }
});
