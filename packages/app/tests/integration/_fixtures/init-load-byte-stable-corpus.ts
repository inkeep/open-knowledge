/**
 * Byte-unsafe markdown corpus for the init-load-byte-stable regression guard.
 *
 * Each entry exercises one or more architectural-floor NG classes from the
 * canonical NG taxonomy — known irreducible byte-unsafe transformation classes
 * where pipeline round-trip can produce semantically-equivalent but byte-unequal
 * output. The system-level load path under audit MUST NOT mutate disk bytes for
 * any of these inputs, regardless of pipeline lossiness, because the
 * `markdownSemanticallyUnchanged` short-circuit at the first onStoreDocument
 * after load returns BEFORE any disk write fires.
 *
 * Shared across the Bun integration test and the Playwright e2e test.
 *
 * Filename vs. `ng[]` convention:
 *   Filenames carry a descriptive corpus-internal hint (e.g.
 *   `ng4-gfm-alerts.md`). The leading `ngN` digit is a CORPUS-INTERNAL
 *   sequence (not a canonical slug) — kept stable so historical references
 *   stay resolvable. The authoritative classification
 *   is the `ng[]` array, which carries kebab-case slugs that match
 *   the canonical NG taxonomy directly. The drift-check at
 *   `init-load-byte-stable-corpus-coverage.test.ts` validates `ng[]`
 *   against the canonical taxonomy.
 *
 * Maintainers: do NOT reduce coverage of the byte-unsafe NG class set. Every
 * canonical NG class addressed by mega-combo or this corpus is load-bearing
 * because the property under test is a universal claim over the byte-unsafe
 * class set. Adding new entries / consolidating into mega-combo is fine when
 * coverage is preserved (consolidation tracked via the drift-check above).
 * Add new entries when new irreducible-gap classes are characterized.
 */

export interface CorpusEntry {
  filename: string;
  /** Kebab-case slugs from the canonical NG taxonomy. */
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
    // Canonical mapping (filename's `124710` is corpus-internal sequence). Body
    // exercises: doc-start `---` → `***` rewrite, blank-line count
    // normalization, un-padded table padding canonicalization, alert
    // render-fidelity bucket, and backslash-escape R23-PUA preservation.
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

  // Mega-combo — 8 byte-unsafe constructs in one .md doc covering 7 distinct
  // canonical NG classes (the math-footnote-alert render-fidelity bucket
  // absorbs both math/footnote AND alerts). Used as the single mounted doc
  // at the e2e tier to maximize failure-inducing-input strength for the
  // editor-mount composition test, at the same wall-clock cost as a
  // single-doc test.
  //
  // Inclusion criteria: an NG class belongs in mega-combo IF it is
  // composable into a single .md doc alongside the other classes without
  // destroying the property each one exercises.
  //
  // The `ng[]` field uses kebab-case slugs so it matches the canonical NG
  // taxonomy directly — no namespace translation needed by the drift-check.
  //
  // Excluded from mega-combo (rationales live in MEGA_COMBO_EXCLUSIONS at
  // `init-load-byte-stable-corpus-coverage.test.ts`).
  //
  // Drift protection: `init-load-byte-stable-corpus-coverage.test.ts`
  // imports the NG taxonomy from the canonical source and asserts every slug
  // is in mega-combo OR in the explicit exclusion set — adding a new NG
  // class to the canonical taxonomy without addressing it in this corpus
  // fails CI.
  //
  // Order intent: the doc-start `---` → `***` rewrite MUST be first.
  // Other constructs sequenced to avoid parse-time interactions (math
  // block isolated, footnote def at end of its block, alert paragraph
  // standalone).
  {
    filename: 'mega-combo-8ng.md',
    // Slugs the body actually exercises: blank-line-count-normalization
    // (multi-blank), gfm-table-padding-preservation (un-padded GFM table),
    // math-footnote-alert-render-fidelity (math + footnote + alert),
    // backslash-escape-r23-pua-preservation (backslash escapes),
    // entity-ref-preservation (`&amp;`), pua-sentinel-ranges-reserved
    // (PUA sentinels), doc-start-thematic-break-to-asterisks (doc-start
    // `---`). Filename's `8ng` reflects the original 8 distinct constructs
    // (alerts and math/footnote were separately enumerated under the
    // corpus-internal scheme before they were consolidated under the
    // math-footnote-alert render-fidelity bucket).
    ng: [
      'blank-line-count-normalization',
      'gfm-table-padding-preservation',
      'math-footnote-alert-render-fidelity',
      'backslash-escape-r23-pua-preservation',
      'entity-ref-preservation',
      'pua-sentinel-ranges-reserved',
      'doc-start-thematic-break-to-asterisks',
      'lazy-continuation-canonicalization',
    ],
    description:
      'Mega-combo: 8 byte-unsafe constructs in one .md doc — doc-start thematic, multi-blank, GFM table, math+footnote, alert, PUA, backslash, HTML entity. e2e tier target.',
    body:
      // doc-start-thematic-break-to-asterisks — doc-start `---\n\n` parses as thematic break (NOT frontmatter).
      '---' +
      NL +
      NL +
      '# Mega-combo' +
      NL +
      NL +
      'Para after thematic.' +
      // blank-line-count-normalization — multi-blank lines (TRIPLE_NL = three NLs in a row).
      TRIPLE_NL +
      'After triple blank.' +
      NL +
      NL +
      // gfm-table-padding-preservation — un-padded GFM table (canonical pads to widest cell per column).
      '|a|b|c|' +
      NL +
      '|-|-|-|' +
      NL +
      '|x|yy|zzz|' +
      NL +
      '|aa|b|c|' +
      NL +
      NL +
      // math-footnote-alert-render-fidelity — math block + inline math + footnote ref + footnote def
      // (math/footnote/alert share the render-fidelity bucket).
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
      // math-footnote-alert-render-fidelity (alert), backslash-escape-r23-pua-preservation (backslash escapes nested in alert body),
      // entity-ref-preservation (HTML entity ref nested in alert body).
      // The NG-numbered literals below are cosmetic body text, not
      // canonical-taxonomy IDs — kept verbatim to preserve corpus bytes.
      '> [!NOTE]' +
      NL +
      '> alert with \\backslash and \\* escapes (NG10) and HTML &amp; entity (NG11)' +
      NL +
      NL +
      // pua-sentinel-ranges-reserved — PUA sentinels U+E000..U+E004 (R23 guard reserved range).
      'PUA: ' +
      NL +
      NL +
      // lazy-continuation-canonicalization — a list item whose wrapped line
      // continues without indent, and a blockquote continuation without the
      // `> ` prefix (CommonMark 5.2). Both rest byte-divergent from canonical
      // and must survive load verbatim (health checks tolerate via
      // parse-equivalence; the byte comparator keeps them residual-bearing).
      '- lazy list item whose wrapped line' +
      NL +
      'continues without indent.' +
      NL +
      NL +
      '> lazy quote line' +
      NL +
      'continues without the prefix.' +
      NL +
      NL +
      'Tail.' +
      NL,
  },
];

/**
 * Map a corpus filename to the docName the OK server uses (extension-less,
 * relative to the content dir). All corpus entries live at the corpus dir
 * root, so docName === filename without extension.
 */
export function corpusDocName(entry: CorpusEntry): string {
  return entry.filename.replace(/\.(md|mdx)$/i, '');
}
