import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { Compartment, Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import type * as Y from 'yjs';
import { codeLanguages } from '../markdown-code-languages';
import { createAgentFlashSourceExtension } from '../plugins/agent-flash-source';
import { createMdLinkSourceExtension } from '../plugins/md-link-source';
import { createWikiLinkSourceExtension } from '../plugins/wiki-link-source';
import { okCmTheme } from './cm-theme';

export const darkTheme: Extension = okCmTheme({ dark: true });
export const lightTheme: Extension = okCmTheme({ dark: false });

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
