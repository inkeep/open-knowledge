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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: string;
  language?: SupportedLanguage;
  title: string;
  description?: string;
  renderPreview?: (debouncedValue: string) => ReactNode;
  previewDebounceMs?: number;
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

  const onSaveRef = useRef(onSave);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const [draft, setDraft] = useState(initialValue);
  const [debouncedDraft, setDebouncedDraft] = useState(initialValue);

  useEffect(() => {
    if (open) {
      setDraft(initialValue);
      setDebouncedDraft(initialValue);
    }
  }, [open, initialValue]);

  useEffect(() => {
    if (!renderPreview) return;
    if (draft === debouncedDraft) return;
    const timer = window.setTimeout(() => setDebouncedDraft(draft), previewDebounceMs);
    return () => window.clearTimeout(timer);
  }, [draft, debouncedDraft, renderPreview, previewDebounceMs]);

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
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      return;
    }
    if (viewRef.current) return;

    const langExt = resolveLanguageExtension(languageRef.current);
    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(propEditorHighlight),
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
    requestAnimationFrame(() => view.focus());
  };

  const previewEnabled = renderPreview !== undefined;
  const handleSave = () => {
    onSave(draft);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[900px] flex-col gap-3 p-4 sm:max-w-[1400px]">
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
