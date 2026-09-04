import type { ThemeRegistration } from 'shiki/core';

export const OK_SYNTAX_THEME_NAME = 'ok-syntax';

export const okSyntaxTheme: ThemeRegistration & { name: string } = {
  name: OK_SYNTAX_THEME_NAME,
  type: 'dark',
  colors: {
    'editor.foreground': 'var(--foreground)',
    'editor.background': 'var(--background)',
  },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.quoted.docstring'],
      settings: { foreground: 'var(--syntax-comment)', fontStyle: 'italic' },
    },
    {
      scope: ['meta.annotation', 'meta.preprocessor', 'entity.name.function.preprocessor'],
      settings: { foreground: 'var(--syntax-meta)' },
    },

    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'variable.language.this'],
      settings: { foreground: 'var(--syntax-keyword)', fontStyle: 'bold' },
    },

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
        'variable.object.property',
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
      scope: 'meta.definition.method entity.name.function',
      settings: { foreground: 'var(--syntax-attr)' },
    },
    {
      scope: 'entity.other.inherited-class',
      settings: { foreground: 'var(--syntax-var)' },
    },
    {
      scope: 'meta.definition.variable entity.name.function',
      settings: { foreground: 'var(--syntax-var)' },
    },
    {
      scope: 'storage.type.function.arrow',
      settings: { foreground: 'var(--syntax-operator)' },
    },
    {
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

    {
      scope: [
        'string',
        'string.quoted',
        'string.template',
        'markup.inline.raw',
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
      ],
      settings: { foreground: 'var(--syntax-atom)' },
    },

    {
      scope: ['keyword.operator', 'punctuation', 'meta.brace'],
      settings: { foreground: 'var(--syntax-operator)' },
    },

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
    {
      scope: [
        'punctuation.definition.heading',
        'punctuation.definition.bold',
        'punctuation.definition.italic',
        'punctuation.definition.raw',
      ],
      settings: { foreground: 'var(--muted-foreground)' },
    },

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
