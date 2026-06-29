
export interface CorpusEntry {
  filename: string;
  ng: string[];
  description: string;
  body: string;
}

const NL = '\n';
const TRIPLE_NL = NL + NL + NL;

export const CORPUS: CorpusEntry[] = [
  {
    filename: 'happy-path.md',
    ng: [],
    description: 'Vanilla markdown; control case.',
    body:
      '---' +
      NL +
      'title: Hello' +
      NL +
      '---' +
      NL +
      NL +
      '# Header' +
      NL +
      NL +
      'A paragraph with **bold** and *italic*.' +
      NL +
      NL +
      '- list item 1' +
      NL +
      '- list item 2' +
      NL,
  },

  {
    filename: 'ng1-multiblank.md',
    ng: ['blank-line-count-normalization'],
    description: 'Three blank lines between paragraphs (remark collapses to 2).',
    body:
      'First paragraph.' +
      NL +
      TRIPLE_NL +
      'Second paragraph after triple blank lines.' +
      NL +
      NL +
      NL +
      NL +
      NL +
      'Third paragraph after quadruple blank lines.' +
      NL,
  },

  {
    filename: 'ng2-table-widths.md',
    ng: ['gfm-table-padding-preservation'],
    description: 'GFM table with un-padded columns (canonical pads to widest cell per column).',
    body:
      '# Table test' +
      NL +
      NL +
      '|a|b|c|' +
      NL +
      '|-|-|-|' +
      NL +
      '|x|yy|zzz|' +
      NL +
      '|aa|b|c|' +
      NL +
      NL +
      'Trailing paragraph.' +
      NL,
  },

  {
    filename: 'ng3-math-footnotes.md',
    ng: ['math-footnote-alert-render-fidelity'],
    description:
      'Math block + inline footnote ref (math-footnote-alert-render-fidelity render-fidelity bucket).',
    body:
      '# Math + footnotes' +
      NL +
      NL +
      '$$' +
      NL +
      'E = mc^2' +
      NL +
      '$$' +
      NL +
      NL +
      'Inline math: $a + b$.' +
      NL +
      NL +
      'A footnote ref[^1] here.' +
      NL +
      NL +
      '[^1]: footnote definition' +
      NL,
  },

  {
    filename: 'ng4-gfm-alerts.md',
    ng: ['math-footnote-alert-render-fidelity'],
    description:
      'GFM alerts (NOTE / WARNING / IMPORTANT). Canonical math-footnote-alert-render-fidelity covers ' +
      'alerts as part of the math/footnote/alert render-fidelity bucket.',
    body:
      '# Alerts' +
      NL +
      NL +
      '> [!NOTE]' +
      NL +
      '> This is a note alert.' +
      NL +
      NL +
      '> [!WARNING]' +
      NL +
      '> This is a warning alert.' +
      NL +
      '> Multi-line warning.' +
      NL +
      NL +
      '> [!IMPORTANT]' +
      NL +
      '> This is important.' +
      NL,
  },

  {
    filename: 'ng5-mdx-yaml-in-jsx.mdx',
    ng: ['mdx-jsx-thematic-break'],
    description:
      'MDX with frontmatter delimiter "---" appearing inside JSX content. ' +
      'Canonical mdx-jsx-thematic-break: MDX `---` inside JSX parses as thematicBreak.',
    body:
      '---' +
      NL +
      'layout: post' +
      NL +
      '---' +
      NL +
      NL +
      '<Note>' +
      NL +
      '---' +
      NL +
      'This dash sequence is INSIDE the JSX, not a thematic break.' +
      NL +
      '---' +
      NL +
      '</Note>' +
      NL +
      NL +
      'Following paragraph.' +
      NL,
  },

  {
    filename: 'ng6-block-inside-jsx.mdx',
    ng: ['mdx-inline-gfm-block-flatten'],
    description:
      'GFM table + alert nested inside <Note> JSX block. Canonical mdx-inline-gfm-block-flatten: ' +
      'block-GFM-inside-inline-JSX flattens to inline content on parse.',
    body:
      '# Mixed' +
      NL +
      NL +
      '<Note>' +
      NL +
      NL +
      '|col1|col2|' +
      NL +
      '|----|----|' +
      NL +
      '|a|b|' +
      NL +
      NL +
      '> [!NOTE]' +
      NL +
      '> nested alert' +
      NL +
      NL +
      '</Note>' +
      NL,
  },

  {
    filename: 'ng7-doc-start-thematic.md',
    ng: ['doc-start-thematic-break-to-asterisks'],
    description:
      'Doc starts with --- (parsed as thematic break, NOT frontmatter). ' +
      'Canonical doc-start-thematic-break-to-asterisks: doc-start `---` round-trips as `***` to defeat ' +
      'remark-frontmatter empty-YAML ambiguity.',
    body: `---${NL}${NL}# After thematic break${NL}${NL}Paragraph.${NL}`,
  },

  {
    filename: 'ng8-frontmatter-only.md',
    ng: ['empty-doc-paragraph-synthesis'],
    description:
      'Frontmatter-only document (no body); pipeline appends synthesized ' +
      'empty paragraph. Canonical empty-doc-paragraph-synthesis: ignore-typed-only docs cannot produce ' +
      'a valid PM doc; ensureNonEmptyDoc synthesizes a paragraph.',
    body:
      '---' +
      NL +
      'title: FM only' +
      NL +
      'tags:' +
      NL +
      '  - one' +
      NL +
      '  - two' +
      NL +
      '---' +
      NL,
  },

  {
    filename: 'ng9-pua-sentinels.md',
    ng: ['pua-sentinel-ranges-reserved'],
    description: 'PUA characters in U+E000-U+E004 (storage must preserve verbatim).',
    body:
      '# PUA test' +
      NL +
      NL +
      'sentinel A: ' +
      NL +
      'sentinel B: ' +
      NL +
      'sentinel C: ' +
      NL +
      'sentinel D: ' +
      NL +
      'sentinel E: ' +
      NL +
      NL +
      'tail paragraph' +
      NL,
  },

  {
    filename: 'ng10-backslash-escapes.md',
    ng: ['backslash-escape-r23-pua-preservation'],
    description:
      'Backslash-escapes (ambiguous and non-ambiguous) preserved verbatim. ' +
      'Canonical backslash-escape-r23-pua-preservation: backslash-escape preservation for R23-PUA chars.',
    body:
      '# Backslash escapes' +
      NL +
      NL +
      'Not punctuation: \\foo \\bar \\baz' +
      NL +
      NL +
      'Punctuation: \\* \\_ \\\\' +
      NL +
      NL +
      'Inline: a\\xb' +
      NL,
  },

  {
    filename: 'ng11-html-entities.md',
    ng: ['entity-ref-preservation'],
    description:
      'HTML entity refs (&amp;, &lt;, &gt;, &copy;) preserved verbatim. ' +
      'Canonical entity-ref-preservation: HTML entity ref preservation via entity-ref-guard ' +
      '(PUA U+E100/U+E101 length-preserving delimiters).',
    body:
      '# HTML entities' +
      NL +
      NL +
      'AT&amp;T &amp;' +
      NL +
      'less than &lt; greater than &gt;' +
      NL +
      'copyright &copy; 2026' +
      NL +
      'numeric &#65; decimal &#x41; hex' +
      NL,
  },

  {
    filename: 'combo-ng124710.md',
    ng: [
      'blank-line-count-normalization',
      'gfm-table-padding-preservation',
      'math-footnote-alert-render-fidelity',
      'backslash-escape-r23-pua-preservation',
      'doc-start-thematic-break-to-asterisks',
    ],
    description:
      'Combinatorial: starts with thematic break, has multi-blank, table, alert, escape.',
    body:
      '---' +
      NL +
      NL +
      'Pre-content paragraph.' +
      NL +
      TRIPLE_NL +
      '|x|y|' +
      NL +
      '|-|-|' +
      NL +
      '|a|bbb|' +
      NL +
      NL +
      '> [!NOTE]' +
      NL +
      '> alert with \\backslash and \\* punct' +
      NL +
      NL +
      'Tail.' +
      NL,
  },

  {
    filename: 'mega-combo-8ng.md',
    ng: [
      'blank-line-count-normalization',
      'gfm-table-padding-preservation',
      'math-footnote-alert-render-fidelity',
      'backslash-escape-r23-pua-preservation',
      'entity-ref-preservation',
      'pua-sentinel-ranges-reserved',
      'doc-start-thematic-break-to-asterisks',
    ],
    description:
      'Mega-combo: 8 byte-unsafe constructs in one .md doc — doc-start thematic, multi-blank, GFM table, math+footnote, alert, PUA, backslash, HTML entity. e2e tier target.',
    body:
      '---' +
      NL +
      NL +
      '# Mega-combo' +
      NL +
      NL +
      'Para after thematic.' +
      TRIPLE_NL +
      'After triple blank.' +
      NL +
      NL +
      '|a|b|c|' +
      NL +
      '|-|-|-|' +
      NL +
      '|x|yy|zzz|' +
      NL +
      '|aa|b|c|' +
      NL +
      NL +
      '$$' +
      NL +
      'E = mc^2' +
      NL +
      '$$' +
      NL +
      NL +
      'Inline math: $a + b$. Footnote ref[^combo1] here.' +
      NL +
      NL +
      '[^combo1]: footnote definition for mega-combo' +
      NL +
      NL +
      '> [!NOTE]' +
      NL +
      '> alert with \\backslash and \\* escapes (NG10) and HTML &amp; entity (NG11)' +
      NL +
      NL +
      'PUA: ' +
      NL +
      NL +
      'Tail.' +
      NL,
  },
];

export function corpusDocName(entry: CorpusEntry): string {
  return entry.filename.replace(/\.(md|mdx)$/i, '');
}
