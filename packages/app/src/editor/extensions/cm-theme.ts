/**
 * The CodeMirror theme every CM surface in the app shares.
 *
 * Colors come from the app's CSS custom properties rather than a bundled
 * palette, so a selected IDE color theme repaints source mode, the diff view,
 * the text viewer, the text-doc editor and the Mermaid editor the same way it
 * repaints the rest of the chrome. Every CM surface shares this one theme; a
 * per-surface
 * `basicDark`/`basicLight` pair would pin its syntax colors to a bundled
 * palette that no theme can reach.
 *
 * Tag → token mapping follows base16's slot roles, which is what makes it
 * meaningful across arbitrary imported schemes: `--syntax-var` is base16's
 * "variables / tags" slot, `--syntax-string` its "strings" slot, and so on.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Token colors, keyed on Lezer tags. Markdown constructs come first because
 * source mode is the dominant surface; the general programming tags below it
 * cover fenced code blocks, which CM parses with a nested language.
 */
const okSyntaxHighlight = HighlightStyle.define([
  // --- markdown ---
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
  // The `#`, `*`, backtick markers themselves — deliberately recessive so the
  // content reads first.
  { tag: tags.processingInstruction, color: 'var(--muted-foreground)' },

  // --- comments + meta ---
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: [tags.meta, tags.annotation, tags.namespace], color: 'var(--syntax-meta)' },
  { tag: tags.docComment, color: 'var(--syntax-comment)', fontStyle: 'italic' },

  // --- keywords ---
  {
    tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword],
    color: 'var(--syntax-keyword)',
    fontWeight: '600',
  },
  { tag: [tags.modifier, tags.self], color: 'var(--syntax-keyword)' },

  // --- names ---
  { tag: tags.tagName, color: 'var(--syntax-tag)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--syntax-attr)' },
  { tag: [tags.variableName, tags.macroName], color: 'var(--syntax-var)' },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.name), tags.labelName],
    color: 'var(--syntax-func)',
  },

  // --- literals ---
  { tag: [tags.string, tags.character, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.integer, tags.float, tags.literal], color: 'var(--syntax-number)' },
  {
    tag: [tags.bool, tags.null, tags.atom, tags.constant(tags.name), tags.standard(tags.name)],
    color: 'var(--syntax-atom)',
  },
  { tag: [tags.regexp, tags.escape], color: 'var(--syntax-atom)' },
  { tag: tags.color, color: 'var(--syntax-atom)' },

  // --- punctuation ---
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

  // --- diff + invalid ---
  { tag: tags.inserted, color: 'var(--diff-added)' },
  { tag: tags.deleted, color: 'var(--diff-removed)' },
  { tag: tags.changed, color: 'var(--syntax-number)' },
  { tag: tags.invalid, color: 'var(--destructive)' },
]);

/** Per-surface chrome, for the few CM hosts that don't sit on `--background`. */
export interface OkCmThemeOptions {
  /** Whether the resolved app mode is dark — CodeMirror's own `&dark` selector hook. */
  dark: boolean;
  /** Editor canvas. Defaults to transparent so the CM inherits its host's surface. */
  background?: string;
  /** Gutter canvas. Defaults to transparent for the same reason. */
  gutterBackground?: string;
}

/**
 * The editor chrome — caret, selection, gutters, active line. Shared visuals
 * that `globals.css` already owns (font, padding, focus outline, scrollbar) are
 * deliberately absent so the two don't compete.
 */
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

/**
 * The full theme bundle: chrome plus token colors. `fallback: true` keeps
 * unstyled tags on CodeMirror's base styling rather than leaving them unpainted.
 */
export function okCmTheme(options: OkCmThemeOptions): Extension[] {
  return [createOkCmTheme(options), syntaxHighlighting(okSyntaxHighlight, { fallback: true })];
}
