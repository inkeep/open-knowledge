import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import type { PropDefString } from '@inkeep/open-knowledge-core';
import { tags } from '@lezer/highlight';
import { mermaid } from 'codemirror-lang-mermaid';
import { useEffect, useRef } from 'react';
import { computeChange } from '../extensions/RawMdxFallbackCMView';

type LanguageName = NonNullable<PropDefString['language']>;

function resolveLanguageExtension(language: LanguageName): Extension {
  switch (language) {
    case 'html':
      return html();
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'javascript':
      return javascript({ jsx: true, typescript: true });
    case 'markdown':
      return markdown();
    case 'latex':
      return StreamLanguage.define(stex);
    case 'mermaid':
      return mermaid();
  }
}

export const propEditorHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: tags.controlKeyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: tags.modifier, color: 'var(--syntax-keyword)' },
  { tag: tags.tagName, color: 'var(--syntax-tag)' },
  { tag: tags.typeName, color: 'var(--syntax-tag)' },
  { tag: tags.className, color: 'var(--syntax-tag)' },
  { tag: tags.attributeName, color: 'var(--syntax-attr)' },
  { tag: tags.propertyName, color: 'var(--syntax-attr)' },
  { tag: tags.variableName, color: 'var(--syntax-attr)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: tags.number, color: 'var(--syntax-number)' },
  { tag: tags.bool, color: 'var(--syntax-number)' },
  { tag: tags.null, color: 'var(--syntax-number)' },
  { tag: tags.atom, color: 'var(--syntax-atom)' },
  { tag: tags.literal, color: 'var(--syntax-number)' },
  { tag: tags.operator, color: 'var(--syntax-keyword)' },
  { tag: tags.punctuation, color: 'var(--foreground)' },
  { tag: tags.bracket, color: 'var(--foreground)' },
  { tag: tags.brace, color: 'var(--foreground)' },
  { tag: tags.meta, color: 'var(--muted-foreground)' },
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
]);

interface CodeMirrorPropInputProps {
  value: string;
  language: LanguageName;
  onChange: (value: string) => void;
  id?: string;
  ariaLabelledBy?: string;
  autoFocus?: boolean;
}

export function CodeMirrorPropInput({
  value,
  language,
  onChange,
  id,
  ariaLabelledBy,
  autoFocus,
}: CodeMirrorPropInputProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const initialValueRef = useRef(value);
  const initialLanguageRef = useRef(language);
  const initialAutoFocusRef = useRef(autoFocus);
  const initialAriaLabelledByRef = useRef(ariaLabelledBy);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      syntaxHighlighting(propEditorHighlight),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const next = update.state.doc.toString();
        onChangeRef.current(next);
      }),
      EditorState.tabSize.of(2),
      languageCompartmentRef.current.of(resolveLanguageExtension(initialLanguageRef.current)),
    ];

    const view = new EditorView({
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions,
      }),
      parent: wrapper,
    });
    viewRef.current = view;

    if (initialAriaLabelledByRef.current) {
      view.contentDOM.setAttribute('aria-labelledby', initialAriaLabelledByRef.current);
    }
    view.contentDOM.setAttribute('aria-multiline', 'true');

    if (initialAutoFocusRef.current) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (ariaLabelledBy) {
      view.contentDOM.setAttribute('aria-labelledby', ariaLabelledBy);
    } else {
      view.contentDOM.removeAttribute('aria-labelledby');
    }
  }, [ariaLabelledBy]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(resolveLanguageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const change = computeChange(current, value);
    if (!change) return;
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.text },
    });
  }, [value]);

  return (
    <div
      ref={wrapperRef}
      id={id}
      className="ok-prop-codemirror"
      data-prop-codemirror=""
      data-prop-language={language}
    />
  );
}
