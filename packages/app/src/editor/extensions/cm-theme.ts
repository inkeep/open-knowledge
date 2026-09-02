import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const okSyntaxHighlight = HighlightStyle.define([
  {
    tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3],
    color: 'var(--syntax-func)',
    fontWeight: 'bold',
  },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--syntax-func)' },
  { tag: tags.strong, fontWeight: 'bold', color: 'var(--foreground)' },
  { tag: tags.emphasis, fontStyle: 'italic', color: 'var(--foreground)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  {
    tag: tags.link,
    color: 'var(--link-color)',
    textDecoration: 'underline',
    textUnderlinePosition: 'under',
  },
  { tag: tags.url, color: 'var(--syntax-attr)' },
  { tag: tags.monospace, color: 'var(--syntax-string)' },
  { tag: tags.quote, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--syntax-keyword)' },
  { tag: tags.contentSeparator, color: 'var(--syntax-comment)' },
  { tag: tags.processingInstruction, color: 'var(--muted-foreground)' },

  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: [tags.meta, tags.annotation, tags.namespace], color: 'var(--syntax-meta)' },
  { tag: tags.docComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },

  {
    tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword],
    color: 'var(--syntax-keyword)',
    fontWeight: '600',
  },
  { tag: [tags.modifier, tags.self], color: 'var(--syntax-keyword)' },

  { tag: tags.tagName, color: 'var(--syntax-tag)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--syntax-attr)' },
  { tag: [tags.variableName, tags.macroName], color: 'var(--syntax-var)' },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.name), tags.labelName],
    color: 'var(--syntax-func)',
  },

  { tag: [tags.string, tags.character, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.integer, tags.float, tags.literal], color: 'var(--syntax-number)' },
  {
    tag: [tags.bool, tags.null, tags.atom, tags.constant(tags.name), tags.standard(tags.name)],
    color: 'var(--syntax-atom)',
  },
  { tag: [tags.regexp, tags.escape], color: 'var(--syntax-atom)' },
  { tag: tags.color, color: 'var(--syntax-atom)' },

  {
    tag: [
      tags.operator,
      tags.punctuation,
      tags.separator,
      tags.bracket,
      tags.brace,
      tags.paren,
      tags.squareBracket,
      tags.angleBracket,
    ],
    color: 'var(--syntax-operator)',
  },

  { tag: tags.inserted, color: 'var(--diff-added)' },
  { tag: tags.deleted, color: 'var(--diff-removed)' },
  { tag: tags.changed, color: 'var(--syntax-number)' },
  { tag: tags.invalid, color: 'var(--destructive)' },
]);

export interface OkCmThemeOptions {
  dark: boolean;
  background?: string;
  gutterBackground?: string;
}

function createOkCmTheme(options: OkCmThemeOptions): Extension {
  const background = options.background ?? 'transparent';
  const gutterBackground = options.gutterBackground ?? 'transparent';
  return EditorView.theme(
    {
      '&': { color: 'var(--foreground)', backgroundColor: background },
      '.cm-content': { caretColor: 'var(--foreground)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--selection-soft)',
      },
      '.cm-selectionMatch': {
        backgroundColor: 'color-mix(in oklab, var(--syntax-type) 30%, transparent)',
      },
      '.cm-gutters': {
        backgroundColor: gutterBackground,
        color: 'var(--muted-foreground)',
        border: 'none',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in oklab, var(--foreground) 4%, transparent)',
      },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--muted)',
        color: 'var(--muted-foreground)',
        border: 'none',
      },
      '.cm-panels': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)' },
      '.cm-searchMatch': {
        backgroundColor: 'color-mix(in oklab, var(--syntax-type) 30%, transparent)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in oklab, var(--primary) 40%, transparent)',
      },
    },
    { dark: options.dark },
  );
}

export function okCmTheme(options: OkCmThemeOptions): Extension[] {
  return [createOkCmTheme(options), syntaxHighlighting(okSyntaxHighlight, { fallback: true })];
}
