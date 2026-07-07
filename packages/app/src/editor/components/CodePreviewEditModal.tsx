/**
 * CodePreviewEditModal — shared "edit-source-in-modal" surface for
 * preview-rendering nodes.
 *
 * Today's consumer: HTML preview code blocks (`html preview` fence — see
 * `CodeBlockView`'s edit button). Designed as a reusable component so
 * future preview-class nodes (Mermaid, Math) can wire in without
 * duplicating the dialog + CodeMirror plumbing.
 *
 * Layout: two columns inside a shadcn `<Dialog>`. CodeMirror on the
 * left, live preview on the right. The preview consumes a *debounced*
 * draft (default 300ms) so heavy preview surfaces (HTML iframe, KaTeX
 * lazy load, Mermaid layout) don't thrash on every keystroke. The
 * source editor itself stays buttery — debouncing only the preview.
 *
 * Keyboard:
 *   - `Esc` cancels and closes the modal (matches every other shadcn
 *     dialog in the editor). The draft is discarded.
 *   - `Cmd/Ctrl + Enter` commits — calls `onSave(currentDraft)` then
 *     closes. Mirrors the GitHub / Linear "post comment" convention so
 *     authors don't need to mouse to the Save button mid-edit.
 *
 * Save shape: `onSave(value: string)` is the integration point. The
 * caller owns the doc-level mutation — `CodeBlockView` replaces the PM
 * node's text content; a future Mermaid/Math wiring would
 * `setNodeMarkup` the `chart` / `formula` prop. The modal stays
 * doc-agnostic.
 *
 * Preview pane is opt-in: passing `renderPreview` mounts the
 * right-hand iframe / KaTeX / Mermaid render; omitting it makes the
 * modal a single-pane source editor for nodes where the preview-while-
 * editing case doesn't apply.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { Trans, useLingui } from '@lingui/react/macro';
import { mermaid } from 'codemirror-lang-mermaid';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { propEditorHighlight } from './CodeMirrorPropInput';

/**
 * Languages the modal's source pane can syntax-highlight. The set is
 * deliberately narrow — preview-class nodes today are HTML (iframe),
 * Mermaid, Math (LaTeX). All three resolve to real Lezer / legacy-mode
 * grammars in `resolveLanguageExtension` below: HTML via
 * `@codemirror/lang-html`, Mermaid via `codemirror-lang-mermaid`, LaTeX
 * via `@codemirror/legacy-modes/mode/stex`. Tokens map onto the shared
 * `propEditorHighlight` style so all three pick up the same `--syntax-*`
 * palette as the PropPanel `CodeMirrorPropInput`.
 */
type SupportedLanguage =
  | 'html'
  | 'css'
  | 'javascript'
  | 'json'
  | 'yaml'
  | 'markdown'
  | 'mermaid'
  | 'latex'
  | 'plain';

function resolveLanguageExtension(lang: SupportedLanguage): Extension | null {
  switch (lang) {
    case 'html':
      return html({ matchClosingTags: true, autoCloseTags: true });
    case 'css':
      return css();
    case 'javascript':
      return javascript({ jsx: true, typescript: true });
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'markdown':
      return markdown();
    case 'mermaid':
      return mermaid();
    case 'latex':
      return StreamLanguage.define(stex);
    case 'plain':
      return null;
  }
}

export interface CodePreviewEditModalProps {
  /** Controlled open state of the dialog. */
  open: boolean;
  /** Called when the dialog requests close (X click, outside click, Esc). */
  onOpenChange: (open: boolean) => void;
  /**
   * Source text to seed the editor when the modal opens. Subsequent
   * changes to `initialValue` while the modal is open are ignored —
   * the editor owns its own draft state from open-time forward.
   */
  initialValue: string;
  /**
   * Language for syntax highlighting + the descriptor under the
   * dialog title (e.g. `"html"` → "Edit HTML source"). Defaults to
   * `"plain"` for nodes without a meaningful language.
   */
  language?: SupportedLanguage;
  /** Dialog title (e.g. "Edit HTML preview", "Edit Mermaid diagram"). */
  title: string;
  /** Optional one-line subtitle under the title (e.g. "Cmd+Enter saves"). */
  description?: string;
  /**
   * Live preview slot — receives the debounced draft. Omit for nodes
   * that don't have a meaningful preview-while-editing surface; the
   * modal then renders as a single-pane source editor.
   */
  renderPreview?: (debouncedValue: string) => ReactNode;
  /**
   * Debounce ms before the preview receives the latest draft. Default
   * 300 — fast enough to feel live, slow enough to not thrash an
   * iframe / KaTeX lazy-render per keystroke.
   */
  previewDebounceMs?: number;
  /**
   * Called when the user commits (Save button or Cmd+Enter). The
   * caller owns the doc-level write; the modal just hands the latest
   * draft string. Modal closes after `onSave` returns.
   */
  onSave: (value: string) => void;
}

export function CodePreviewEditModal({
  open,
  onOpenChange,
  initialValue,
  language = 'plain',
  title,
  description,
  renderPreview,
  previewDebounceMs = 300,
  onSave,
}: CodePreviewEditModalProps) {
  const { t } = useLingui();

  // Mirror the parent's callbacks into refs so the CodeMirror mount
  // effect can close over them WITHOUT listing them in deps. Without
  // this, every parent re-render (CodeBlockView and JsxComponentView
  // both declare `onSave` inline so its identity changes per render)
  // would re-run the mount effect, tearing down + recreating the
  // EditorView in a loop. The host briefly held no children between
  // teardown and remount — visible as a blank source pane in the dev
  // app even though the DOM tests passed.
  const onSaveRef = useRef(onSave);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  // Draft holds the live editor contents — synced from the editor's
  // doc on every change. Seeded from `initialValue` on each *open* so
  // the modal can be reused across multiple click → edit → save
  // cycles on the same node without a stale-draft carryover.
  const [draft, setDraft] = useState(initialValue);
  // Debounced view of `draft` for the preview pane. Heavy preview
  // surfaces (HTML iframe srcDoc, KaTeX, Mermaid render) re-mount on
  // every value change; debouncing keeps the iframe + lazy renders
  // off the per-keystroke path.
  const [debouncedDraft, setDebouncedDraft] = useState(initialValue);

  // Re-seed the draft each time the modal opens. The `open` edge is
  // the lifecycle boundary — between opens, `initialValue` may have
  // shifted (remote peer edits, other surface writes) but the modal
  // intentionally captures the value at open-time and lets the author
  // commit-or-cancel against that snapshot.
  useEffect(() => {
    if (open) {
      setDraft(initialValue);
      setDebouncedDraft(initialValue);
    }
  }, [open, initialValue]);

  // Debounce draft → debouncedDraft.
  useEffect(() => {
    if (!renderPreview) return;
    if (draft === debouncedDraft) return;
    const timer = window.setTimeout(() => setDebouncedDraft(draft), previewDebounceMs);
    return () => window.clearTimeout(timer);
  }, [draft, debouncedDraft, renderPreview, previewDebounceMs]);

  // ─── CodeMirror mount ────────────────────────────────────────────────
  //
  // The mount uses a *callback ref* + a per-language ref instead of
  // `useEffect + useRef`. Radix Dialog portals its content asynchronously
  // after `open` flips true — `useEffect` was firing before the host div
  // was actually in the DOM (`hostRef.current === null`), and the
  // matching cleanup never fired to retry. The callback ref fires
  // EXACTLY when the host node attaches (and again, with `null`, when it
  // detaches), so the EditorView mounts at the right moment regardless
  // of portal timing.
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(language);
  const initialValueRef = useRef(initialValue);
  useEffect(() => {
    languageRef.current = language;
  }, [language]);
  useEffect(() => {
    initialValueRef.current = initialValue;
  }, [initialValue]);

  const setHostRef = (host: HTMLDivElement | null) => {
    if (!host) {
      // Detach: Radix unmounted the dialog content; destroy our view.
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      return;
    }
    // Attach: idempotent — multiple attaches of the same host (HMR /
    // StrictMode double-invoke) should not stack EditorViews.
    if (viewRef.current) return;

    // Extension stack mirrors the proven `CodeMirrorPropInput` pattern
    // (sibling PropPanel component, used by Math / Mermaid prop editing).
    // NO `basicSetup` — its bundled theme + base styling fights with the
    // modal's surface tokens. NO `EditorView.theme` — visuals come
    // entirely from the `.ok-codepreview-cm` CSS class in `globals.css`,
    // which uses app CSS variables so light / dark tracks the host theme
    // automatically (no Compartment needed).
    const langExt = resolveLanguageExtension(languageRef.current);
    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        // `defaultHighlightStyle` provides minimum CM6 token styling
        // (`{ fallback: true }` so it sits under the per-token overrides
        // below). `propEditorHighlight` maps token tags to the app's
        // semantic `--syntax-*` CSS variables — same palette
        // `CodeMirrorPropInput` uses for Math + Mermaid prop editing,
        // tuned for WCAG-AA contrast on both light and dark surfaces.
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(propEditorHighlight),
        // `indentWithTab` MUST come first so Tab inserts indentation
        // instead of moving focus to the next dialog control (the
        // browser's default Tab handling). Esc still bubbles to Radix
        // so the dialog close path works.
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: (view) => {
              onSaveRef.current(view.state.doc.toString());
              onOpenChangeRef.current(false);
              return true;
            },
          },
        ]),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        // Language grammar — null for plaintext-only surfaces (CM
        // gracefully edits without highlighting).
        ...(langExt ? [langExt] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setDraft(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    // Focus on next frame — focusing synchronously can race Radix
    // Dialog's own focus-into-content path. rAF lets Radix settle.
    requestAnimationFrame(() => view.focus());
  };

  // ─── Render ──────────────────────────────────────────────────────────
  const previewEnabled = renderPreview !== undefined;
  const handleSave = () => {
    onSave(draft);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Wide + tall — preview-while-editing needs real estate. The
        // default DialogContent gives `w-full max-w-[calc(100%-2rem)]`
        // up to the `sm` breakpoint; we lift the cap to 1400px above
        // it. The `w-[Nvw]` near-fullscreen pattern guard
        // (fullscreen-overlay-safe-area-coverage.test.ts) is avoided
        // by relying on the default width — the dialog already sits
        // 1rem inside the viewport edge on each side.
        className="flex h-[85vh] max-h-[900px] flex-col gap-3 p-4 sm:max-w-[1400px]"
      >
        <DialogHeader className="gap-1">
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <DialogDescription>
              <Trans>
                Type to edit; <Kbd>⌘ Enter</Kbd> saves, <Kbd>Esc</Kbd> cancels.
              </Trans>
            </DialogDescription>
          )}
        </DialogHeader>
        <div
          className={`flex min-h-0 flex-1 gap-3 ${previewEnabled ? 'flex-col md:flex-row' : 'flex-col'}`}
          data-testid="ok-code-preview-edit-modal-body"
        >
          <div
            ref={setHostRef}
            className="ok-codepreview-cm min-h-[260px] flex-1 overflow-hidden rounded-md border border-border md:min-h-0"
            data-testid="ok-code-preview-edit-modal-source"
            // Exposed so DOM tests can pin the language the modal mounted
            // with — guards a regression where the consumer passed `'plain'`
            // by accident (e.g. mismatched alias resolution at the call
            // site) and the syntax-highlight path silently degraded to
            // plain text.
            data-language={language}
          />
          {previewEnabled ? (
            <div
              className="min-h-[260px] flex-1 overflow-auto rounded-md border border-border bg-muted/30 md:min-h-0"
              data-testid="ok-code-preview-edit-modal-preview"
            >
              {renderPreview(debouncedDraft)}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={handleSave} aria-label={t`Save changes`}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
