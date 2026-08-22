export type DroppedTokenAdjudication =
  | {
      kind: 'format-dof-axis';
      axisIds: readonly string[];
      rationale: string;
    }
  | {
      kind: 'structural-only';
      rationale: string;
    }
  | {
      kind: 'retained-by-capture';
      witness: string;
      rationale: string;
    }
  | {
      kind: 'documented-residual';
      witnesses: ReadonlyArray<{ input: string; roundTrip: string }>;
      rationale: string;
    };

export const DROPPED_TOKEN_ADJUDICATIONS: Record<string, DroppedTokenAdjudication> = {
  atxHeadingText: {
    kind: 'structural-only',
    rationale: 'heading-text container; bytes ride inside its phrasing children',
  },
  autolinkMarker: {
    kind: 'format-dof-axis',
    axisIds: ['autolink:angle'],
    rationale: 'the < > wrapper of an autolink; the angle form is the witnessed axis',
  },
  blockQuoteMarker: {
    kind: 'format-dof-axis',
    axisIds: ['blockquote:marker-spacing'],
    rationale: 'the > marker byte; its spacing variation is the witnessed axis',
  },
  blockQuotePrefix: {
    kind: 'format-dof-axis',
    axisIds: ['blockquote:marker-spacing'],
    rationale: 'marker + following whitespace; covered by the marker-spacing axis',
  },
  blockQuotePrefixWhitespace: {
    kind: 'format-dof-axis',
    axisIds: ['blockquote:marker-spacing'],
    rationale:
      'the whitespace after the > marker; the marker-spacing axis varies exactly these bytes',
  },
  characterReferenceMarker: {
    kind: 'format-dof-axis',
    axisIds: ['lexical:char-reference'],
    rationale:
      'the & and ; of an entity reference; preserved by the entity-ref guard, witnessed by the lexical axis',
  },
  chunkContent: {
    kind: 'structural-only',
    rationale: 'tokenizer re-chunking artifact; spans only bytes owned by nested tokens',
  },
  chunkDocument: {
    kind: 'structural-only',
    rationale: 'tokenizer re-chunking artifact; spans only bytes owned by nested tokens',
  },
  chunkFlow: {
    kind: 'structural-only',
    rationale: 'tokenizer re-chunking artifact; spans only bytes owned by nested tokens',
  },
  chunkString: {
    kind: 'structural-only',
    rationale: 'tokenizer re-chunking artifact; spans only bytes owned by nested tokens',
  },
  chunkText: {
    kind: 'structural-only',
    rationale: 'tokenizer re-chunking artifact; spans only bytes owned by nested tokens',
  },
  codeFencedFenceSequence: {
    kind: 'format-dof-axis',
    axisIds: ['code-fence:char', 'code-fence:symmetric-length', 'code-fence:closing-length'],
    rationale:
      'the fence run itself; char, length, and closing-length variation are the witnessed axes',
  },
  codeTextPadding: {
    kind: 'retained-by-capture',
    witness: '` x `',
    rationale: 'inline-code pad space; retained via the inlineCode sourcePadded capture',
  },
  codeTextSequence: {
    kind: 'retained-by-capture',
    witness: '``x``',
    rationale: 'inline-code fence run; retained via the inlineCode fence-length capture',
  },
  content: {
    kind: 'structural-only',
    rationale: 'flow-content container; spans only bytes owned by nested tokens',
  },
  definitionDestination: {
    kind: 'structural-only',
    rationale:
      'destination container; bytes ride in its literal/raw child tokens into mdast definition.url',
  },
  definitionDestinationLiteral: {
    kind: 'retained-by-capture',
    witness: '[a]: </u v>',
    rationale: 'angle-bracketed definition destination; the angle form round-trips',
  },
  definitionDestinationLiteralMarker: {
    kind: 'retained-by-capture',
    witness: '[a]: </u v>',
    rationale: 'the < > of an angle-bracketed definition destination; round-trips with the literal',
  },
  definitionDestinationRaw: {
    kind: 'retained-by-capture',
    witness: '[a]: /u',
    rationale: 'raw definition destination; bytes land in mdast definition.url and re-emit',
  },
  definitionLabel: {
    kind: 'retained-by-capture',
    witness: '[A]: /u\n\n[a]',
    rationale: 'definition label with authored casing; the label byte form re-emits',
  },
  definitionLabelMarker: {
    kind: 'structural-only',
    rationale: 'fixed [ ] bytes around the definition label; no source-form freedom',
  },
  definitionMarker: {
    kind: 'structural-only',
    rationale: 'the fixed : byte after the definition label; no source-form freedom',
  },
  definitionTitle: {
    kind: 'retained-by-capture',
    witness: "[a]: /u 'ti'",
    rationale: 'definition title with authored quote style; the quote form re-emits',
  },
  definitionTitleMarker: {
    kind: 'retained-by-capture',
    witness: "[a]: /u 'ti'",
    rationale: 'the quote bytes of a definition title; round-trip with the title',
  },
  emphasisSequence: {
    kind: 'format-dof-axis',
    axisIds: ['emphasis:delimiter'],
    rationale: 'the * or _ run; delimiter choice is the witnessed axis',
  },
  emphasisText: {
    kind: 'structural-only',
    rationale: 'emphasis-content container; bytes ride inside its phrasing children',
  },
  escapeMarker: {
    kind: 'format-dof-axis',
    axisIds: ['lexical:backslash-escape'],
    rationale: 'the backslash of an escape; preserved end-to-end, witnessed by the lexical axis',
  },
  labelEnd: {
    kind: 'structural-only',
    rationale: 'fixed ] byte; the reference-form freedom is retained via mdast referenceType',
  },
  labelImage: {
    kind: 'structural-only',
    rationale: 'image-label container; fixed ![ ] bytes plus child phrasing',
  },
  labelImageMarker: {
    kind: 'structural-only',
    rationale: 'the fixed ! byte of an image label; no source-form freedom',
  },
  labelLink: {
    kind: 'structural-only',
    rationale: 'link-label container; fixed [ ] bytes plus child phrasing',
  },
  labelMarker: {
    kind: 'structural-only',
    rationale: 'fixed [ or ] byte; no source-form freedom',
  },
  lineEndingBlank: {
    kind: 'format-dof-axis',
    axisIds: [
      'block-separator:blank-line-count',
      'doc-boundary:doc-leading-blank',
      'doc-boundary:doc-trailing-blank',
    ],
    rationale:
      'blank-line newlines; leading/trailing/inter-block blank runs are the witnessed axes',
  },
  linePrefix: {
    kind: 'format-dof-axis',
    axisIds: ['lexical:tab-expansion', 'atx:leading-indent', 'code-fence:leading-indent'],
    rationale: 'leading line indent (tabs or spaces); the indent axes vary exactly these bytes',
  },
  lineSuffix: {
    kind: 'documented-residual',
    witnesses: [
      { input: 'a \nb', roundTrip: 'a\nb\n' },
      { input: 'a   \nb', roundTrip: 'a  \nb\n' },
    ],
    rationale:
      'trailing intra-line whitespace: a single trailing space is stripped (CommonMark soft line ' +
      'breaks treat it as presentational) and a hard-break space run beyond two normalizes to two. ' +
      'Not an enumerated format-DOF axis and not captured today; pinned here so any shift is loud.',
  },
  listItemIndent: {
    kind: 'format-dof-axis',
    axisIds: ['list:nested-indent-width'],
    rationale: 'continuation indent of a list item; the nested-indent axis varies these bytes',
  },
  listItemMarker: {
    kind: 'format-dof-axis',
    axisIds: [
      'list:bullet-plus',
      'list:ordered-paren-delim',
      'list:ordered-start-number',
      'list:ordered-renumber',
    ],
    rationale: 'the bullet or ordinal marker; marker char and ordinal axes vary these bytes',
  },
  listItemPrefix: {
    kind: 'format-dof-axis',
    axisIds: ['list:item-marker-spacing'],
    rationale: 'marker + following whitespace; the marker-spacing axis varies these bytes',
  },
  listItemPrefixWhitespace: {
    kind: 'format-dof-axis',
    axisIds: ['list:item-marker-spacing'],
    rationale:
      'the whitespace after a list marker; the marker-spacing axis varies exactly these bytes',
  },
  referenceMarker: {
    kind: 'structural-only',
    rationale:
      'fixed [ ] bytes of a reference; the form freedom is retained via mdast referenceType',
  },
  resourceDestination: {
    kind: 'structural-only',
    rationale: 'destination container; bytes ride in its literal/raw child tokens into mdast url',
  },
  resourceDestinationLiteral: {
    kind: 'format-dof-axis',
    axisIds: ['link:angle-url'],
    rationale: 'angle-bracketed resource destination; the angle form is the witnessed axis',
  },
  resourceDestinationLiteralMarker: {
    kind: 'format-dof-axis',
    axisIds: ['link:angle-url'],
    rationale: 'the < > of an angle-bracketed destination; covered by the angle-url axis',
  },
  resourceDestinationRaw: {
    kind: 'retained-by-capture',
    witness: '[t](/u)',
    rationale: 'raw resource destination; bytes land in mdast url and re-emit via the link handler',
  },
  resourceMarker: {
    kind: 'structural-only',
    rationale: 'fixed ( ) bytes of a resource; no source-form freedom',
  },
  resourceTitle: {
    kind: 'structural-only',
    rationale:
      'title container; the title value rides into mdast title, quote style via the title-quote axis',
  },
  resourceTitleMarker: {
    kind: 'format-dof-axis',
    axisIds: ['link:title-quote'],
    rationale: 'the quote bytes of a resource title; quote style is the witnessed axis',
  },
  setextHeadingLine: {
    kind: 'format-dof-axis',
    axisIds: ['setext:underline'],
    rationale: 'the setext underline run; the underline form is the witnessed axis',
  },
  strongSequence: {
    kind: 'format-dof-axis',
    axisIds: ['strong:delimiter'],
    rationale: 'the ** or __ run; delimiter choice is the witnessed axis',
  },
  strongText: {
    kind: 'structural-only',
    rationale: 'strong-content container; bytes ride inside its phrasing children',
  },
  thematicBreakSequence: {
    kind: 'format-dof-axis',
    axisIds: ['thematic:marker-mid-doc', 'thematic:doc-start-forcing'],
    rationale:
      'the thematic-break marker run; marker form and doc-start forcing are the witnessed axes',
  },
  whitespace: {
    kind: 'documented-residual',
    witnesses: [{ input: '[a]:   /u', roundTrip: '[a]: /u\n' }],
    rationale:
      'inter-part whitespace inside definition/resource constructs collapses to a single space on ' +
      'serialize. Not an enumerated format-DOF axis and not captured today; pinned here so any ' +
      'shift is loud.',
  },
};

export type PreprocessTransformAdjudication =
  | { kind: 'format-dof-axis'; axisIds: readonly string[]; rationale: string }
  | { kind: 'structural-only'; rationale: string }
  | {
      kind: 'spec-mandated-replacement';
      witness: { input: string; roundTrip: string };
      rationale: string;
    };

export const PREPROCESS_TRANSFORM_ADJUDICATIONS: Record<string, PreprocessTransformAdjudication> = {
  '\0': {
    kind: 'spec-mandated-replacement',
    witness: { input: 'a\0b', roundTrip: 'a�b\n' },
    rationale:
      'CommonMark 2.3 (insecure characters): U+0000 must be replaced with U+FFFD. A divergence no ' +
      'fix may close; doubles as the instrument-alive control in the format-DOF gates.',
  },
  '\t': {
    kind: 'format-dof-axis',
    axisIds: ['lexical:tab-expansion'],
    rationale:
      'tabs encode as virtual spaces in preprocess; the indent-tab byte form is the witnessed axis',
  },
  '\n': {
    kind: 'structural-only',
    rationale:
      'LF chunk encoding; LF is the canonical line ending and round-trips byte-identically',
  },
  '\r': {
    kind: 'format-dof-axis',
    axisIds: ['doc-boundary:line-ending-normalize'],
    rationale:
      'CR / CRLF encoding; line-ending form is the witnessed axis (OK retains interior CRLF)',
  },
  'bom-head-check': {
    kind: 'format-dof-axis',
    axisIds: ['doc-boundary:bom-strip'],
    rationale:
      'preprocess strips a document-head U+FEFF before any event exists; OK captures it with its ' +
      'own pre-parse head check, witnessed by the bom-strip axis',
  },
};

export const PINNED_PREPROCESS_SOURCE_SHA256 =
  'b582f16d9bc04d93d388004544be9c5293fda614eb86f8d02b97c3e57b9409e1';

export function extractFromMarkdownHandlerKeys(libSource: string): string[] {
  const keys = new Set<string>();
  for (const label of ['enter', 'exit']) {
    const start = libSource.indexOf(`${label}: {`);
    if (start < 0) throw new Error(`from-markdown source lost its "${label}" handler block`);
    let index = libSource.indexOf('{', start);
    let depth = 0;
    const lines: string[] = [];
    let lineStart = index + 1;
    for (; index < libSource.length; index++) {
      const ch = libSource[index];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      } else if (ch === '\n') {
        if (depth === 1) lines.push(libSource.slice(lineStart, index));
        lineStart = index + 1;
      }
    }
    if (depth !== 0) throw new Error(`unbalanced "${label}" handler block`);
    for (const line of lines) {
      const match = /^\s*([a-zA-Z][\w]*):/.exec(line);
      if (match?.[1]) keys.add(match[1]);
    }
  }
  if (keys.size === 0) throw new Error('extracted zero from-markdown handler keys');
  return [...keys].sort();
}

export function extractPreprocessTransforms(preprocessSource: string): {
  transformChars: string[];
  hasBomHeadCheck: boolean;
} {
  const match = /const search = \/\[(.+?)\]\/g/.exec(preprocessSource);
  if (!match?.[1]) throw new Error('preprocess source lost its search regex');
  const chars: string[] = [];
  const body = match[1];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      const next = body[i + 1];
      i++;
      if (next === '0') chars.push('\0');
      else if (next === 't') chars.push('\t');
      else if (next === 'n') chars.push('\n');
      else if (next === 'r') chars.push('\r');
      else if (next !== undefined) chars.push(next);
    } else if (ch !== undefined) {
      chars.push(ch);
    }
  }
  return {
    transformChars: chars,
    hasBomHeadCheck: /65279|byteOrderMarker/.test(preprocessSource),
  };
}

export interface ClosureCheckResult {
  unadjudicated: string[];
  stale: string[];
}

export function checkClosure(
  computed: readonly string[],
  adjudicated: Readonly<Record<string, unknown>>,
): ClosureCheckResult {
  const computedSet = new Set(computed);
  return {
    unadjudicated: computed.filter((key) => !(key in adjudicated)).sort(),
    stale: Object.keys(adjudicated)
      .filter((key) => !computedSet.has(key))
      .sort(),
  };
}
