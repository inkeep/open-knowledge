/**
 * Shared CodeMirror extension factory.
 *
 * Single source of truth for every CM instance in the app — both the full-page
 * `SourceEditor` and every nested CM mounted inside a PM NodeView
 * (rawMdxFallback, future per-block source toggles).
 *
 * Both consumers share: markdown language, wiki-link + md-link decorations,
 * agent-flash decoration (when a Y.Doc is available), optional line wrapping,
 * and a per-instance theme Compartment. Source-mode adds `basicSetup`,
 * y-codemirror collaboration, and a full-height theme on top of this factory.
 *
 * Each nested CM instance MUST create its own Compartment for theme
 * reconfiguration. Module-scoped theme singletons cause cross-instance
 * reconfigure conflicts.
 */

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

// Theme factories — each caller gets a fresh theme object.
// Background is transparent so the CM inherits its host's surface:
//   - SourceEditor: host surface is `var(--background)` (the page) → reads
//     identical to a solid-background theme.
//   - rawMdxFallback wrappers: host surface is the severity-tinted wrapper
//     (muted / amber-50 / destructive/5). Without transparency, the CM
//     paints a pure-white panel inside the tinted wrapper, creating a
//     raised-panel / inner-shadow illusion. Transparent keeps the CM flush
//     with its host.
export const darkTheme = basicDarkInit({
  settings: {
    background: 'transparent',
    gutterBackground: 'transparent',
  },
});

// Overrides for basicLightStyle tokens that fail WCAG AA contrast on white.
// Same Nord hue, darker lightness. NOTE: tagHighlighter overwrites per-tag-id —
// later specs fully replace earlier ones, no CSS cascade — so any override on a
// tag with formatting (bold/italic/underline) must repeat those attrs.
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
  /** Per-instance theme compartment — caller MUST create their own */
  themeCompartment: Compartment;
  /** Current resolved theme */
  resolvedTheme: string | undefined;
  /** Y.Doc for agent-flash decoration. When omitted, agent-flash is skipped. */
  ydoc?: Y.Doc;
  /** Per-instance word-wrap compartment for runtime reconfiguration. */
  wordWrapCompartment?: Compartment;
  /** Whether long lines should wrap. Defaults to true to preserve historical behavior. */
  wordWrap?: boolean;
  /** Override keybindings for nested mode (e.g., Cmd-Z → PM undo) */
  extraKeymaps?: Extension;
  /**
   * docName this editor is bound to, used to context-rank `[[` wiki-link
   * completions (link-graph boost + skill-folder penalty). Omit for nested/
   * sub-document CMs with no single owning page — they rank filter-only.
   */
  currentDocName?: string | null;
}

/**
 * Create extension array for a CodeMirror instance.
 * Shared by full-page SourceEditor and every nested CM inside a PM NodeView.
 * Excludes basicSetup, yCollab, and full-height theme — source mode adds those.
 */
export function createNestedCMExtensions(options: NestedCMOptions): Extension[] {
  const { themeCompartment, resolvedTheme, ydoc } = options;
  const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
  const wordWrapExtension: Extension = (options.wordWrap ?? true) ? EditorView.lineWrapping : [];

  // Shared visuals (font-size, font-family, line padding, focus outline,
  // scrollbar) are owned by `globals.css` so the factory doesn't compete
  // with those rules. Keep the factory to behavior (language, decorations,
  // theme, wrapping) only — that way both consumers render identically.
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
