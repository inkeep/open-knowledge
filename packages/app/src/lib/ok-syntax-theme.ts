/**
 * The Shiki theme every Shiki-backed surface in the app shares — Pierre's diff
 * and conflict views, and the agent-markdown code blocks.
 *
 * It is the Shiki-side twin of `editor/extensions/cm-theme.ts`: both resolve
 * their token colors to the same `--syntax-*` custom properties, so a selected
 * IDE color theme repaints a conflict hunk and the source editor beside it the
 * same way. A bundled palette (Pierre's own `pierre-light`/`pierre-dark`
 * default, or `github-*`) pins its colors at build time and no theme can reach
 * them, which is what let those surfaces drift apart.
 *
 * Emitting `var(...)` from a theme's `foreground` is a first-class Shiki
 * mechanism, not a trick — it is exactly what `createCssVariablesTheme`
 * produces. That helper is not used here because it exposes only ten coarse
 * token slots (numbers and constants share one; types, tags and attributes
 * have none), which cannot express the thirteen slots `cm-theme.ts` paints.
 * Authoring the scope map directly is what makes the two surfaces agree.
 *
 * Scope → slot follows base16's role vocabulary, the same reasoning as
 * `cm-theme.ts`: the accent slots have fixed roles rather than fixed hues, so
 * one mapping stays meaningful across arbitrary imported schemes.
 *
 * ONE theme, not a light/dark pair. The `--syntax-*` values already flip with
 * the app's mode, so a pair would make Pierre resolve the mode a second time
 * off its own detection and fight the app's. The choice also decides which
 * `--diffs-*` properties Pierre writes at `:host`: the pair branch emits
 * `--diffs-light-*`/`--diffs-dark-*`, which SHADOW the `--diffs-*` values
 * `globals.css` sets and win silently. Under one theme those shadowing
 * properties are never emitted, so the stylesheet's conflict chrome is what
 * actually reaches the surface.
 *
 * Which is why this theme carries syntax colors and nothing else — see the
 * `colors` block.
 *
 * Note that Shiki replaces every color it resolves with a sentinel hex while
 * normalizing and maps it back at tokenize time, so the `var(...)` strings are
 * observable in tokenizer OUTPUT, not on the loaded theme. Assert against
 * tokens.
 */

import type { ThemeRegistration } from 'shiki/core';

/** Registered name. Shiki and Pierre both key the theme by this string. */
export const OK_SYNTAX_THEME_NAME = 'ok-syntax';

export const okSyntaxTheme: ThemeRegistration & { name: string } = {
  name: OK_SYNTAX_THEME_NAME,
  // Cosmetic: every color below is a custom property that resolves per mode,
  // so the declared type never selects a palette. Shiki requires the field.
  type: 'dark',
  // Syntax only. Deliberately no `gitDecoration.*`: Pierre expands those into
  // `--diffs-addition-color` / `--diffs-modified-color`, which fill the whole
  // current and incoming halves of a merge conflict. Those are chrome, they
  // are set in `globals.css` beside the rest of the `--diffs-*` block, and
  // leaving them unset here is what lets that block reach them.
  colors: {
    'editor.foreground': 'var(--foreground)',
    'editor.background': 'var(--background)',
  },
  tokenColors: [
    // --- comments + meta ---
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.quoted.docstring'],
      settings: { foreground: 'var(--syntax-comment)', fontStyle: 'italic' },
    },
    {
      scope: ['meta.annotation', 'meta.preprocessor', 'entity.name.function.preprocessor'],
      settings: { foreground: 'var(--syntax-meta)' },
    },

    // --- keywords ---
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'variable.language.this'],
      settings: { foreground: 'var(--syntax-keyword)', fontStyle: 'bold' },
    },

    // --- names ---
    {
      scope: ['entity.name.tag', 'entity.name.tag.yaml'],
      settings: { foreground: 'var(--syntax-tag)' },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
      settings: { foreground: 'var(--syntax-type)' },
    },
    {
      scope: [
        'entity.other.attribute-name',
        'meta.property-name',
        'support.type.property-name',
        'variable.other.property',
        // Type members and class fields.
        'variable.object.property',
        // Object-literal keys, which the grammar otherwise leaves unstyled —
        // the widest single gap against source mode, since it shows up in
        // every object and every JSON-ish block.
        'meta.object-literal.key',
      ],
      settings: { foreground: 'var(--syntax-attr)' },
    },
    {
      scope: ['variable', 'variable.other', 'meta.definition.variable'],
      settings: { foreground: 'var(--syntax-var)' },
    },
    {
      scope: ['entity.name.function', 'meta.function-call', 'support.function'],
      settings: { foreground: 'var(--syntax-func)' },
    },
    {
      // A method DEFINITION, not a call. Lezer tags it `propertyName` — a
      // method is a property of the class — so source mode paints it in the
      // attr slot; the descendant selector is what separates it from the
      // `entity.name.function` rule above, which still owns call sites.
      scope: 'meta.definition.method entity.name.function',
      settings: { foreground: 'var(--syntax-attr)' },
    },
    {
      // Superclass position. Lezer reads `extends X` as the value expression
      // it is in JavaScript and tags it `variableName`.
      scope: 'entity.other.inherited-class',
      settings: { foreground: 'var(--syntax-var)' },
    },
    {
      // `const fn = () => {}` — the grammar calls the binding a function,
      // Lezer calls it the variable it is.
      scope: 'meta.definition.variable entity.name.function',
      settings: { foreground: 'var(--syntax-var)' },
    },
    {
      // `=>` is punctuation to Lezer, storage to the grammar.
      scope: 'storage.type.function.arrow',
      settings: { foreground: 'var(--syntax-operator)' },
    },
    {
      // Lezer paints a regex literal as one flat token, so the grammar's
      // finer breakdown (delimiters, quantifiers, flags) has to collapse back
      // into the same slot or a regex reads as four colors in one surface and
      // one in the other.
      // Each selector's LAST element has to out-specify the rule it is
      // overriding — `string.regexp punctuation` loses to the bare
      // `punctuation.definition.string` above, which has more dot-parts.
      scope: [
        'string.regexp punctuation.definition.string',
        'keyword.operator.quantifier.regexp',
        'string.regexp keyword.other',
      ],
      settings: { foreground: 'var(--syntax-atom)' },
    },
    {
      scope: 'variable.parameter',
      settings: { foreground: 'var(--syntax-var)' },
    },

    // --- literals ---
    {
      scope: [
        'string',
        'string.quoted',
        'string.template',
        'markup.inline.raw',
        // CodeMirror paints a string's delimiters with its body; without this
        // the grammar's `punctuation` rule below would claim the quotes.
        'punctuation.definition.string',
      ],
      settings: { foreground: 'var(--syntax-string)' },
    },
    {
      scope: ['constant.numeric', 'constant.other.placeholder'],
      settings: { foreground: 'var(--syntax-number)' },
    },
    {
      scope: [
        'constant.language',
        'constant.character',
        'constant.character.escape',
        'string.regexp',
        // No `variable.other.constant`: TextMate gives every `const` binding
        // that scope, so claiming it here painted ordinary variables as
        // literals — where Lezer, and therefore source mode, calls them
        // variables. Left off, it falls through to `variable.other` below.
      ],
      settings: { foreground: 'var(--syntax-atom)' },
    },

    // --- punctuation ---
    {
      scope: ['keyword.operator', 'punctuation', 'meta.brace'],
      settings: { foreground: 'var(--syntax-operator)' },
    },

    // --- markdown ---
    // Kept in step with the markdown block of `cm-theme.ts`: source mode is
    // the surface a reader most often has open next to one of these.
    {
      scope: ['markup.heading', 'entity.name.section'],
      settings: { foreground: 'var(--syntax-func)', fontStyle: 'bold' },
    },
    { scope: 'markup.bold', settings: { foreground: 'var(--foreground)', fontStyle: 'bold' } },
    { scope: 'markup.italic', settings: { foreground: 'var(--foreground)', fontStyle: 'italic' } },
    { scope: 'markup.strikethrough', settings: { fontStyle: 'strikethrough' } },
    {
      scope: ['markup.underline.link', 'string.other.link'],
      settings: { foreground: 'var(--link-color)', fontStyle: 'underline' },
    },
    {
      scope: 'markup.quote',
      settings: { foreground: 'var(--syntax-comment)', fontStyle: 'italic' },
    },
    {
      scope: 'beginning.punctuation.definition.list',
      settings: { foreground: 'var(--syntax-keyword)' },
    },
    // The `#`, backtick and emphasis markers themselves — recessive, so the
    // content reads before its syntax does.
    {
      scope: [
        'punctuation.definition.heading',
        'punctuation.definition.bold',
        'punctuation.definition.italic',
        'punctuation.definition.raw',
      ],
      settings: { foreground: 'var(--muted-foreground)' },
    },

    // --- diff + invalid ---
    {
      scope: ['markup.inserted', 'punctuation.definition.inserted'],
      settings: { foreground: 'var(--diff-added)' },
    },
    {
      scope: ['markup.deleted', 'punctuation.definition.deleted'],
      settings: { foreground: 'var(--diff-removed)' },
    },
    {
      scope: ['markup.changed', 'punctuation.definition.changed'],
      settings: { foreground: 'var(--syntax-number)' },
    },
    { scope: 'invalid', settings: { foreground: 'var(--destructive)' } },
  ],
};
