
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { Compartment, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';
import { basicDarkInit, basicLightInit } from '@uiw/codemirror-theme-basic';
import type * as Y from 'yjs';
import { codeLanguages } from '../markdown-code-languages';
import { createAgentFlashSourceExtension } from '../plugins/agent-flash-source';
import { createMdLinkSourceExtension } from '../plugins/md-link-source';
import { createWikiLinkSourceExtension } from '../plugins/wiki-link-source';

export const darkTheme = basicDarkInit({
  settings: {
    background: 'transparent',
    gutterBackground: 'transparent',
  },
});

export const lightTheme = basicLightInit({
  settings: {
    background: 'transparent',
    gutterBackground: 'transparent',
  },
  styles: [
    { tag: [t.brace, t.processingInstruction, t.inserted], color: '#3d6968' },
    {
      tag: t.link,
      color: '#3d6968',
      textDecoration: 'underline',
      textUnderlinePosition: 'under',
    },
    {
      tag: [
        t.keyword,
        t.function(t.variableName),
        t.regexp,
        t.color,
        t.constant(t.name),
        t.standard(t.name),
      ],
      color: '#345575',
    },
    {
      tag: [t.heading, t.special(t.heading1), t.heading1, t.heading2, t.heading3, t.heading4],
      color: '#345575',
      fontWeight: 'bold',
    },
    { tag: [t.heading5, t.heading6], color: '#345575' },
    { tag: t.strong, color: '#345575', fontWeight: 'bold' },
    { tag: t.emphasis, color: '#345575', fontStyle: 'italic' },
    {
      tag: [
        t.name,
        t.deleted,
        t.character,
        t.propertyName,
        t.macroName,
        t.variableName,
        t.angleBracket,
        t.string,
        t.url,
        t.escape,
        t.special(t.string),
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: '#9a5739',
    },
    {
      tag: [t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace, t.meta],
      color: '#3d6968',
    },
    {
      tag: [t.definition(t.name), t.separator, t.operator, t.operatorKeyword],
      color: '#4a6938',
    },
    {
      tag: [t.typeName, t.className, t.attributeName, t.contentSeparator],
      color: '#8b6500',
    },
    { tag: t.tagName, color: '#774d70' },
    { tag: t.squareBracket, color: '#964148' },
    { tag: t.labelName, color: '#3a5e85' },
  ],
});

interface NestedCMOptions {
  themeCompartment: Compartment;
  resolvedTheme: string | undefined;
  ydoc?: Y.Doc;
  wordWrapCompartment?: Compartment;
  wordWrap?: boolean;
  extraKeymaps?: Extension;
  currentDocName?: string | null;
}

export function createNestedCMExtensions(options: NestedCMOptions): Extension[] {
  const { themeCompartment, resolvedTheme, ydoc } = options;
  const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
  const wordWrapExtension: Extension = (options.wordWrap ?? true) ? EditorView.lineWrapping : [];

  return [
    markdown({ base: markdownLanguage, extensions: [GFM], codeLanguages }),
    createWikiLinkSourceExtension(options.currentDocName ?? null),
    createMdLinkSourceExtension(),
    ...(ydoc ? [createAgentFlashSourceExtension(ydoc)] : []),
    keymap.of([]),
    themeCompartment.of(theme),
    options.wordWrapCompartment
      ? options.wordWrapCompartment.of(wordWrapExtension)
      : wordWrapExtension,
    ...(options.extraKeymaps ? [options.extraKeymaps] : []),
  ];
}
