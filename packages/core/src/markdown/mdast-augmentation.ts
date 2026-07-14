import type { Position } from 'unist';

export const PROMOTED_MDAST_TYPES = [
  'wikiLink',
  'wikiLinkEmbed',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
  'rawMdxFallback',
  'mark',
  'tag',
  'comment',
  'commentBlock',
  'footnoteReference',
  'footnoteDefinition',
] as const;

export type PromotedMdastType = (typeof PROMOTED_MDAST_TYPES)[number];

export interface WikiLinkMdast {
  type: 'wikiLink';
  value: string;
  data: {
    target: string;
    alias: string | null;
    anchor: string | null;
    sourceTarget?: string | null;
    sourceAnchor?: string | null;
    sourceAlias?: string | null;
    [key: string]: unknown;
  };
  children: Array<{ type: 'text'; value: string }>;
  position?: Position;
}

export interface WikiLinkEmbedMdast {
  type: 'wikiLinkEmbed';
  value: string;
  data: {
    target: string;
    alias: string | null;
    anchor: string | null;
    /** Untrimmed source segments — see WikiLinkMdast. Captured by the
     * shared micromark exits; the embed serialization path currently
     * ignores them (embed fidelity is tracked separately). */
    sourceTarget?: string | null;
    sourceAnchor?: string | null;
    sourceAlias?: string | null;
    [key: string]: unknown;
  };
  children: Array<{ type: 'text'; value: string }>;
  position?: Position;
}

export interface RawMdxFallbackMdast {
  type: 'rawMdxFallback';
  value: string;
  data: {
    reason: string;
    originalSpan: { start: number; end: number };
    [key: string]: unknown;
  };
  position?: Position;
}

export interface CommentMdast {
  type: 'comment';
  // biome-ignore lint/suspicious/noExplicitAny: see RootContentMap note above
  children: Array<any>;
  data?: {
    sourceForm?: 'percent' | 'html';
    [key: string]: unknown;
  };
  position?: Position;
}

export interface CommentBlockMdast {
  type: 'commentBlock';
  // biome-ignore lint/suspicious/noExplicitAny: see RootContentMap note above
  children: Array<any>;
  data?: {
    sourceForm?: 'percent' | 'html';
    sourceLayout?: 'inline' | 'block';
    [key: string]: unknown;
  };
  position?: Position;
}

export interface MarkMdast {
  type: 'mark';
  // biome-ignore lint/suspicious/noExplicitAny: see RootContentMap note above
  children: Array<any>;
  data?: { sourceRaw?: string; [key: string]: unknown };
  position?: Position;
}

export interface TagMdast {
  type: 'tag';
  value: string;
  data?: { sourceRaw?: string; [key: string]: unknown };
  position?: Position;
}

export interface SourceDocBoundary {
  bom?: true;
  leading?: string;
  trailing?: string;
  gapBlankLines?: ReadonlyArray<number | null>;
}

declare module 'mdast' {
  interface Data {
    sourcePrecedingBlankLines?: number;
  }
  interface RootData {
    sourceDocBoundary?: SourceDocBoundary;
  }
  interface TextData {
    escapedChars?: Array<{ offset: number; char: string }>;
    sourceRaw?: string;
    entityRefSpans?: Array<{ offset: number; length: number; raw: string }>;
  }
  interface EmphasisData {
    sourceDelimiter?: '*' | '_';
  }
  interface StrongData {
    sourceDelimiter?: '**' | '__';
  }
  interface LinkData {
    sourceStyle?: string;
    sourceRaw?: string;
    sourceUrlForm?: 'angle-bracketed';
    sourceTitleMarker?: 'single' | 'double' | 'paren';
  }
  interface LinkReferenceData {
    sourceRaw?: string;
  }
  interface ThematicBreakData {
    sourceRaw?: string;
  }
  interface BreakData {
    sourceStyle?: string;
    sourceRaw?: string;
  }
  interface HeadingData {
    sourceStyle?: string;
    sourceTrailingHashes?: number;
    sourceLeadingIndent?: number;
    sourceInteriorSpacing?: number;
    sourceUnderlineLength?: number;
    sourceContiguousNext?: boolean;
  }
  interface CodeData {
    sourceFenceChar?: string;
    sourceFenceLength?: number;
    sourceClosingFenceLength?: number;
    sourceFenceIndent?: number;
    sourceInfoPadding?: number;
    sourceStyle?: 'indented' | 'fenced';
    sourceIndents?: string[];
  }
  interface InlineCodeData {
    sourceFenceChar?: string;
    sourceFenceLength?: number;
    sourcePadded?: boolean;
  }
  interface ListData {
    bulletMarker?: string;
    listMarkerDelimiter?: string;
  }
  interface ListItemData {
    sourceMarkerSpacing?: number;
    sourceOrdinal?: number;
    sourceCheckboxChar?: 'X';
    sourceContinuationIndent?: number;
  }
  interface DeleteData {
    sourceDelimiter?: '~' | '~~';
  }
  interface BlockquoteData {
    sourceMarkerSpacings?: Array<number | 'single' | 'none' | 'lazy'>;
  }
  interface TableData {
    sourceDashCounts?: number[];
    sourceOuterPipes?: { leading: boolean; trailing: boolean };
    sourceAlignmentPadding?: Array<{ left: number; right: number }>;
  }
  interface TableCellData {
    sourcePadding?: { left: number; right: number };
  }
  interface DefinitionData {
    sourceLayout?: 'multiline' | 'inline';
    sourceTitleMarker?: 'single' | 'double' | 'paren';
  }
  interface RootContentMap {
    wikiLink: WikiLinkMdast;
    rawMdxFallback: RawMdxFallbackMdast;
    wikiLinkEmbed: WikiLinkEmbedMdast;
    mark: MarkMdast;
    tag: TagMdast;
    comment: CommentMdast;
    commentBlock: CommentBlockMdast;
  }
}

declare module 'mdast-util-mdx-jsx' {
  interface MdxJsxFlowElementData {
    sourceRaw?: string;
    htmlBoundary?: { opener: string; closer: string };
  }
  interface MdxJsxTextElementData {
    sourceRaw?: string;
  }
}

declare module 'mdast-util-mdx-expression' {
  interface MdxFlowExpressionData {
    sourceRaw?: string;
  }
  interface MdxTextExpressionData {
    sourceRaw?: string;
  }
}

declare module 'mdast-util-math' {
  interface InlineMathData {
    sourceDelimiter?: string;
  }
}
