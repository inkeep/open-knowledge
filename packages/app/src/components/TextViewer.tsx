/**
 * Read-only CodeMirror viewer for plain-text data files in the asset
 * preview pane. Dispatched from `AssetPreview` when the file's
 * `mediaKind === 'text'` — either because the extension is in
 * `SIDEBAR_TEXT_EXTENSIONS` (json / toml / lock) or because the user clicked
 * the in-pane "View as text" button (in which case
 * the override forces `'text'` regardless of extension).
 *
 * The viewer fetches the file bytes via `fetch()` against
 * `/api/asset-text?path=…` — the sibling endpoint that skips the
 * `ASSET_EXTENSIONS` allowlist and ignore-filter so any path-safe file
 * can be inspected (yaml / csv / .DS_Store / arbitrary text-shaped
 * formats). CodeMirror renders the content read-only with a language
 * extension picked from the file extension (json / toml today, with `lock` falling through to the plain-text branch below; plain
 * text for everything else opened via the in-pane override).
 *
 * STOP: do NOT bind this to a Y.Doc or hand it a Y.Text. The on-disk
 * file is read-only here by contract; CRDT-backed editing for text
 * assets would need a real source-of-truth model (file mtime, conflict
 * resolution, save affordance) that lives on a separate spec. This
 * viewer is a one-way render.
 */

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { codeLanguageForExtension } from '@inkeep/open-knowledge-core';
import { basicDarkInit, basicLightInit } from '@uiw/codemirror-theme-basic';
import { basicSetup } from 'codemirror';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { loadCodeMirrorLanguageForExtension } from './text-viewer-languages';
import { useViewerText, type ViewerTextSource } from './use-viewer-text';
import { ViewerErrorPane, ViewerLoadingPane } from './ViewerStatusPane';

const darkTheme = basicDarkInit({
  settings: {
    background: 'var(--background)',
    gutterBackground: 'var(--muted)',
  },
});

const lightTheme = basicLightInit({
  settings: {
    background: 'var(--background)',
    gutterBackground: 'var(--muted)',
  },
});

/**
 * Exactly one text source (`src` for a content-dir asset, or `loadText` for a
 * scope-aware skill-bundle read) plus the display coordinates. The source half
 * is the `ViewerTextSource` discriminated union, so "both" / "neither" can't be
 * passed. `src` (when present) also targets the "Open file" fallback link.
 */
type TextViewerProps = ViewerTextSource & {
  fileName: string;
  /** Lowercased, dot-stripped (e.g. `json`, not `.JSON`). */
  extension: string;
};

export function TextViewer({ fileName, extension, ...source }: TextViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { resolvedTheme } = useTheme();
  const fetchState = useViewerText(source);
  // Dep-pin the actual loaded content rather than the discriminated-
  // union reference so loading→loading or error→error transitions
  // don't trigger a CodeMirror teardown / rebuild. Only the loaded
  // payload, the language pick, and the theme should invalidate the
  // editor; everything else flows through the lightweight state-
  // pane render branches above.
  const loadedContent = fetchState.status === 'loaded' ? fetchState.content : null;

  useEffect(() => {
    if (!containerRef.current) return;
    if (loadedContent === null) return;

    const normalized = extension.toLowerCase();
    const canonical = codeLanguageForExtension(normalized);
    const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
    // `editable: true` + `readOnly: true` — the inverse of what looks
    // like the obvious "read-only viewer" pairing. The combination is
    // deliberate:
    //
    //   - `editable: false` would set `contenteditable=false` on the
    //     content surface. CodeMirror then refuses focus, the caret
    //     never lands, the selection keymap (Cmd-A / arrow-shift) never
    //     fires, and Cmd-A bubbles to the document where the browser
    //     selects everything inside the container — including the line-
    //     number gutter — instead of the file content.
    //   - `readOnly: true` is what actually blocks writes. Dispatches
    //     that would mutate the doc are silently dropped at the state
    //     level, so paste / typing / drop are no-ops even with focus.
    //
    // Net: clickable to focus, selectable + Cmd-A acts on the editor
    // content (not the page), Cmd-C copies, but any write attempt is
    // dropped at the state layer. The on-disk file is still untouched.
    // Defer view construction until the language pack chunk lands —
    // each pack is dynamic-imported by `loadCodeMirrorLanguageForExtension`
    // so the main app bundle stays under budget. `aborted` short-circuits
    // a stale resolve when the effect's cleanup fires before the import
    // settles (rapid sidebar navigation, theme toggle mid-load).
    let aborted = false;
    let view: EditorView | null = null;
    void loadCodeMirrorLanguageForExtension(normalized, canonical).then((language) => {
      if (aborted) return;
      if (!containerRef.current) return;
      const extensions = [
        basicSetup,
        ...(language ? [language] : []),
        EditorView.editable.of(true),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        theme,
      ];
      view = new EditorView({
        state: EditorState.create({ doc: loadedContent, extensions }),
        parent: containerRef.current,
      });
      viewRef.current = view;
    });

    return () => {
      aborted = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [loadedContent, extension, resolvedTheme]);

  // `data-text-viewer` is stamped on every branch (loading / error /
  // loaded) so consumers — DOM tests, e2e selectors, the "is this asset
  // in text mode?" check at the asset-preview level — can identify the
  // mounted viewer regardless of the async fetch state. The variant is
  // disambiguated via the sibling `data-text-viewer-state` attribute.
  const extraAttrs = { 'data-text-viewer-extension': extension };
  if (fetchState.status === 'loading') {
    return (
      <ViewerLoadingPane fileName={fileName} dataAttr="data-text-viewer" extraAttrs={extraAttrs} />
    );
  }

  if (fetchState.status === 'error') {
    return (
      <ViewerErrorPane
        fileName={fileName}
        dataAttr="data-text-viewer"
        extraAttrs={extraAttrs}
        message={fetchState.message}
        // Skill bundle files (`loadText` mode) have no asset-server URL, so the
        // "Open file" handoff only applies to the content-dir `src` path.
        openHref={source.src}
      />
    );
  }

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={fileName}
      data-text-viewer=""
      data-text-viewer-state="loaded"
      data-text-viewer-extension={extension}
    >
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto" />
    </main>
  );
}
