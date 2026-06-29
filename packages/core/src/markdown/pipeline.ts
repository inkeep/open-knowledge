
import {
  type FromProseMirrorOptions,
  fromProseMirror,
  type RemarkProseMirrorOptions,
  remarkProseMirror,
} from '@handlewithcare/remark-prosemirror';
import type { Node as PmNode, Schema } from '@tiptap/pm/model';
import type { Root as MdastRoot } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkGithubAlerts from 'remark-github-alerts';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { type Processor, unified } from 'unified';
import { VFile } from 'vfile';

import './mdast-augmentation.ts';
import { protectFromMdx, restoreFromMdx } from './autolink-void-html-guard.ts';
import { encodeBackslashEscapes, restoreBackslashEscapesPlugin } from './backslash-escape-guard.ts';
import { calloutTransformerPlugin, REMARK_GITHUB_ALERTS_OPTIONS } from './callout-transformer.ts';
import { commentPromoterPlugin } from './comment-promoter.ts';
import { dedentBlockJsxClose } from './dedent-block-jsx-close.ts';
import { detailsAccordionPromoterPlugin } from './details-accordion-promoter.ts';
import { encodeEntityRefs, restoreEntityRefsPlugin } from './entity-ref-guard.ts';
import { highlightPromoterPlugin } from './highlight-promoter.ts';
import { imagePromoterPlugin } from './image-promoter.ts';
import { indentedCodePromoterPlugin } from './indented-code-promoter.ts';
import { mathPromoterPlugin } from './math-promoter.ts';
import type { SourceDocBoundary } from './mdast-augmentation.ts';
import { mergedPostParseWalkerPlugin } from './merged-walker.ts';
import { mermaidPromoterPlugin } from './mermaid-promoter.ts';
import { positionAwareBlankLineJoin } from './position-aware-join.ts';
import { remarkMdxAgnostic } from './remark-mdx-agnostic.ts';
import { singleDollarMathPromoterPlugin } from './single-dollar-math-promoter.ts';
import { remarkTags } from './tag-to-markdown.ts';
import { remarkWikiLink } from './wiki-link-micromark.ts';

interface PipelineOptions {
  schema: Schema;
  handlers: RemarkProseMirrorOptions['handlers'];
  pmNodeHandlers: FromProseMirrorOptions<string, string>['nodeHandlers'];
  pmMarkHandlers: FromProseMirrorOptions<string, string>['markHandlers'];
  toMarkdownHandlers?: Record<string, unknown>;
}

/** Options needed by `serializeMd` for the PM→mdast pre-pass. Kept separate
 * from the (pre-baked) processor so one cached serialize processor can serve
 * calls that share schema/handler registrations. */
interface SerializeMdOptions {
  schema: Schema;
  pmNodeHandlers: FromProseMirrorOptions<string, string>['nodeHandlers'];
  pmMarkHandlers: FromProseMirrorOptions<string, string>['markHandlers'];
}

function ensureNonEmptyDoc(tree: MdastRoot): MdastRoot {
  const renderable = tree.children.some((n) => {
    const type = (n as { type: string }).type;
    return type !== 'yaml' && type !== 'toml';
  });
  if (renderable) return tree;
  return {
    ...tree,
    children: [...tree.children, { type: 'paragraph', children: [] } as never],
  };
}

export const ACTIVE_MDAST_PLUGINS = [
  { name: 'remark-parse', plugin: remarkParse },
  { name: 'remark-mdx-agnostic', plugin: remarkMdxAgnostic },
  { name: 'remark-gfm', plugin: remarkGfm },
  { name: 'remark-math', plugin: remarkMath, options: { singleDollarTextMath: false } },
  { name: 'remark-wiki-link', plugin: remarkWikiLink },
  {
    name: 'remark-github-alerts',
    plugin: remarkGithubAlerts,
    options: REMARK_GITHUB_ALERTS_OPTIONS,
  },
  { name: 'callout-transformer', plugin: calloutTransformerPlugin },
  { name: 'restore-from-mdx', plugin: restoreFromMdx },
  { name: 'restore-entity-refs', plugin: restoreEntityRefsPlugin },
  { name: 'restore-backslash-escapes', plugin: restoreBackslashEscapesPlugin },
  { name: 'details-accordion-promoter', plugin: detailsAccordionPromoterPlugin },
  { name: 'image-promoter', plugin: imagePromoterPlugin },
  { name: 'indented-code-promoter', plugin: indentedCodePromoterPlugin },
  { name: 'math-promoter', plugin: mathPromoterPlugin },
  { name: 'single-dollar-math-promoter', plugin: singleDollarMathPromoterPlugin },
  { name: 'highlight-promoter', plugin: highlightPromoterPlugin },
  { name: 'mermaid-promoter', plugin: mermaidPromoterPlugin },
  { name: 'comment-promoter', plugin: commentPromoterPlugin },
  { name: 'merged-post-parse-walker', plugin: mergedPostParseWalkerPlugin },
  { name: 'ensure-non-empty-doc', plugin: () => ensureNonEmptyDoc },
] as const;

export function createParseProcessor(opts: PipelineOptions): Processor {
  let processor = unified() as unknown as Processor;
  for (const entry of ACTIVE_MDAST_PLUGINS) {
    const hasOptions = 'options' in entry && entry.options !== undefined;
    processor = (
      hasOptions
        ? // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugin entries can't be narrowed in iteration
          (processor as any).use(entry.plugin, entry.options)
        : // biome-ignore lint/suspicious/noExplicitAny: same
          (processor as any).use(entry.plugin)
    ) as Processor;
  }
  processor = (
    processor as unknown as {
      use(plugin: typeof remarkProseMirror, opts: RemarkProseMirrorOptions): Processor;
    }
  ).use(remarkProseMirror, {
    schema: opts.schema,
    handlers: opts.handlers,
  } as RemarkProseMirrorOptions);
  processor.freeze();
  return processor;
}

export function createSerializeProcessor(
  opts: Pick<PipelineOptions, 'toMarkdownHandlers'>,
): Processor {
  const processor = unified()
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkMath, { singleDollarTextMath: false })
    .use(remarkMdxAgnostic)
    .use(remarkWikiLink)
    .use(remarkTags)
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      rule: '-',
      join: [positionAwareBlankLineJoin],
      ...(opts.toMarkdownHandlers ? { handlers: opts.toMarkdownHandlers } : {}),
    });
  processor.freeze();
  return processor as unknown as Processor;
}

function splitDocumentHeadBom(source: string): { source: string; hadBom: boolean } {
  return source.charCodeAt(0) === 0xfeff
    ? { source: source.slice(1), hadBom: true }
    : { source, hadBom: false };
}

const GAP_CAPTURE_MIN_NEWLINES = 3;

const LEADING_BOUNDARY_SHAPE = /^\n+$/;
const TRAILING_BOUNDARY_SHAPE = /^\n{2,}$/;

function captureDocBoundary(
  root: MdastRoot,
  source: string,
  hadBom: boolean,
): SourceDocBoundary | undefined {
  let leading: string | undefined;
  let trailing: string | undefined;
  let gapBlankLines: Array<number | null> | undefined;

  const children = root.children;
  if (children.length > 0) {
    const firstStart = children[0]?.position?.start?.offset;
    if (typeof firstStart === 'number' && firstStart > 0) {
      const gap = source.slice(0, firstStart);
      if (LEADING_BOUNDARY_SHAPE.test(gap)) leading = gap;
    }
    const lastEnd = children[children.length - 1]?.position?.end?.offset;
    if (typeof lastEnd === 'number' && lastEnd <= source.length) {
      const gap = source.slice(lastEnd);
      if (TRAILING_BOUNDARY_SHAPE.test(gap)) trailing = gap;
    }
    const gaps: Array<number | null> = [];
    let anyGap = false;
    for (let i = 1; i < children.length; i++) {
      const prevEnd = children[i - 1]?.position?.end?.offset;
      const nextStart = children[i]?.position?.start?.offset;
      let blanks: number | null = null;
      if (typeof prevEnd === 'number' && typeof nextStart === 'number' && nextStart >= prevEnd) {
        const gap = source.slice(prevEnd, nextStart);
        if (new RegExp(`^\\n{${GAP_CAPTURE_MIN_NEWLINES},}$`).test(gap)) {
          blanks = gap.length - 1;
          anyGap = true;
        }
      }
      gaps.push(blanks);
    }
    if (anyGap) gapBlankLines = gaps;
  }

  if (!hadBom && leading === undefined && trailing === undefined && !gapBlankLines) {
    return undefined;
  }
  const boundary: SourceDocBoundary = {
    ...(hadBom ? { bom: true as const } : {}),
    ...(leading !== undefined ? { leading } : {}),
    ...(trailing !== undefined ? { trailing } : {}),
    ...(gapBlankLines ? { gapBlankLines } : {}),
  };
  root.data ??= {};
  root.data.sourceDocBoundary = boundary;
  return boundary;
}

function readDocBoundary(value: unknown): SourceDocBoundary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const out: {
    bom?: true;
    leading?: string;
    trailing?: string;
    gapBlankLines?: Array<number | null>;
  } = {};
  if (v.bom === true) out.bom = true;
  if (typeof v.leading === 'string' && LEADING_BOUNDARY_SHAPE.test(v.leading)) {
    out.leading = v.leading;
  }
  if (typeof v.trailing === 'string' && TRAILING_BOUNDARY_SHAPE.test(v.trailing)) {
    out.trailing = v.trailing;
  }
  if (
    Array.isArray(v.gapBlankLines) &&
    v.gapBlankLines.every(
      (g) =>
        g === null ||
        (typeof g === 'number' && Number.isInteger(g) && g >= GAP_CAPTURE_MIN_NEWLINES - 1),
    )
  ) {
    out.gapBlankLines = v.gapBlankLines as Array<number | null>;
  }
  return out.bom || out.leading || out.trailing || out.gapBlankLines ? out : undefined;
}

export function parseMd(rawSource: string, processor: Processor): PmNode {
  const { source: rawAfterBom, hadBom } = splitDocumentHeadBom(rawSource);
  const source = dedentBlockJsxClose(rawAfterBom);
  const protectedFr14 = encodeBackslashEscapes(source);
  const protectedR23 = protectFromMdx(protectedFr14);
  const protected_ = encodeEntityRefs(protectedR23);

  const file = new VFile(protected_);
  const tree = processor.parse(file);
  file.value = source;
  const transformed = processor.runSync(tree, file) as MdastRoot;
  const boundary = captureDocBoundary(transformed, source, hadBom);
  const doc = (processor as unknown as { stringify(tree: unknown): PmNode }).stringify(transformed);
  if (!boundary) return doc;
  return doc.type.create({ ...doc.attrs, sourceDocBoundary: boundary }, doc.content, doc.marks);
}

export function parseMdToMdast(rawSource: string, processor: Processor): MdastRoot {
  const { source: rawAfterBom, hadBom } = splitDocumentHeadBom(rawSource);
  const source = dedentBlockJsxClose(rawAfterBom);
  const protected_ = encodeEntityRefs(protectFromMdx(encodeBackslashEscapes(source)));
  const file = new VFile(protected_);
  const tree = processor.parse(file);
  file.value = source;
  const transformed = processor.runSync(tree, file) as MdastRoot;
  captureDocBoundary(transformed, source, hadBom);
  return transformed;
}

export function serializeMd(doc: PmNode, processor: Processor, opts: SerializeMdOptions): string {
  const mdast: MdastRoot = fromProseMirror(doc, {
    schema: opts.schema,
    nodeHandlers: opts.pmNodeHandlers,
    markHandlers: opts.pmMarkHandlers,
  });

  const boundary = readDocBoundary(doc.attrs?.sourceDocBoundary);
  const gaps = boundary?.gapBlankLines;
  if (gaps && gaps.length === mdast.children.length - 1) {
    for (let i = 1; i < mdast.children.length; i++) {
      const blanks = gaps[i - 1];
      if (typeof blanks === 'number') {
        const child = mdast.children[i];
        child.data ??= {};
        child.data.sourcePrecedingBlankLines = blanks;
      }
    }
  }

  let out = String(processor.stringify(mdast));
  if (boundary?.leading) out = boundary.leading + out;
  if (boundary?.trailing) {
    out = out.replace(/\n+$/, '') + boundary.trailing;
  }
  if (boundary?.bom) out = `\uFEFF${out}`;
  return out;
}
