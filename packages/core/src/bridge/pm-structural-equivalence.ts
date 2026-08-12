import { isSubsequence } from './subsequence.ts';
import type { ToleranceClassSeverity } from './tolerance-telemetry.ts';

export interface PmStructuralNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmStructuralNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

const VOLATILE_ATTRS = new Set(['sourceRaw', 'sourceDirty', 'position']);

const CONTAINER_TYPES = new Set([
  'jsxComponent',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'list',
  'listItem',
  'blockquote',
  'codeBlock',
  'heading',
]);

/** Canonical marker for a hard line break, the join token every cell-flatten
 *  and void-`<br/>` degrade collapses toward so the three source spellings
 *  (a `hardBreak` node, a block boundary inside a cell, a literal `<br/>`
 *  text run) compare equal. */
const BR_SENTINEL: PmStructuralNode = { type: '__br__' };

const BR_LITERAL_RE = /^<br\s*\/?>$/i;


interface DegradeEntry {
  readonly label: string;
  readonly severity: ToleranceClassSeverity;
  readonly rationale: string;
  readonly proofPointer: string;
  readonly canonicalize: (tree: PmStructuralNode) => PmStructuralNode;
}

function flattenTableCells(node: PmStructuralNode): PmStructuralNode {
  const next = mapChildren(node, flattenTableCells);
  if ((next.type === 'tableCell' || next.type === 'tableHeader') && next.content) {
    return { ...next, content: flattenBlocksToInline(next.content) };
  }
  return next;
}

function flattenBlocksToInline(blocks: PmStructuralNode[]): PmStructuralNode[] {
  const out: PmStructuralNode[] = [];
  for (const block of blocks) {
    const leaves = inlineLeavesOf(block);
    if (leaves.length === 0) continue;
    if (out.length > 0) out.push(BR_SENTINEL);
    out.push(...leaves);
  }
  return out;
}

/** Inline leaves of a node in document order. Text and inline atoms return
 *  themselves; a block with block children flattens (boundaries → `<br/>`);
 *  a block with inline children returns those children. */
function inlineLeavesOf(node: PmStructuralNode): PmStructuralNode[] {
  if (node.text !== undefined || node.type === 'hardBreak' || node.type === 'jsxInline') {
    return [node];
  }
  if (!node.content || node.content.length === 0) return [];
  const childrenAreBlocks = node.content.some(
    (c) => c.text === undefined && c.type !== 'hardBreak' && c.type !== 'jsxInline' && !!c.content,
  );
  return childrenAreBlocks ? flattenBlocksToInline(node.content) : node.content;
}

function unifyHardBreaks(node: PmStructuralNode): PmStructuralNode {
  if (node.type === 'hardBreak' || node.type === BR_SENTINEL.type) return BR_SENTINEL;
  if (node.text !== undefined && BR_LITERAL_RE.test(node.text.trim())) return BR_SENTINEL;
  return mapChildren(node, unifyHardBreaks);
}

const STRUCTURAL_DEGRADE_REGISTRY = [
  {
    label: 'table-cell-block-flatten',
    severity: 'pm-model-caused',
    rationale:
      'GFM table cells have no block spelling; a block placed in a cell is flattened to inline on serialize, so a cell-with-blocks and a cell-with-inline describe the same persisted document.',
    proofPointer:
      'markdown/table-cell-flatten.ts flattenCellBlocks (table-cell-flatten-dropped-block event)',
    canonicalize: flattenTableCells,
  },
  {
    label: 'void-hardbreak-br',
    severity: 'serializer-caused',
    rationale:
      'A void hardBreak inside a table cell or heading serializes to a literal <br /> that a fresh parse keeps as text; the node form and the literal form are the same break.',
    proofPointer: 'markdown/void-br-promoter.ts + markdown/to-markdown-handlers.ts break handler',
    canonicalize: unifyHardBreaks,
  },
] as const satisfies readonly DegradeEntry[];

/** The degrade labels this module can report — derived from the registry, so a
 *  new tolerance is one registry entry, never a scattered string literal. */
export type StructuralDegradeLabel = (typeof STRUCTURAL_DEGRADE_REGISTRY)[number]['label'];

export type StructuralDivergenceReason =
  | 'content-loss'
  | 'structural-shatter'
  | 'structural-divergence'
  | 'pipeline-threw';

export type StructuralEquivalenceResult =
  | {
      equivalent: true;
      level: 'L1' | 'L2';
      appliedDegrades: StructuralDegradeLabel[];
    }
  | {
      equivalent: false;
      level: 'L1' | 'L2';
      reason: StructuralDivergenceReason;
      detail: string;
      appliedDegrades: StructuralDegradeLabel[];
    };

export interface ComparePmStructuralOptions {
  ignoreAttrs?: (attrKey: string) => boolean;
}


/** Rebuild a node with `fn` applied to each child; identity when childless.
 *  Shared by the degrade canonicalizers so none re-implements the walk. */
function mapChildren(
  node: PmStructuralNode,
  fn: (child: PmStructuralNode) => PmStructuralNode,
): PmStructuralNode {
  if (!node.content) return node;
  return { ...node, content: node.content.map(fn) };
}

/** Comparison-form of a node: volatile + empty attrs dropped, marks sorted,
 *  empty content elided. Two nodes are structurally equal iff their reduced
 *  forms stable-stringify identically. `ignoreAttrs` drops caller-nominated
 *  attr keys on top of the fixed volatile set (see ComparePmStructuralOptions). */
function reduce(node: PmStructuralNode, ignoreAttrs?: (key: string) => boolean): unknown {
  const out: Record<string, unknown> = {};
  if (node.type !== undefined) out.type = node.type;
  if (node.text !== undefined) out.text = node.text;
  const attrs = reduceAttrs(node.attrs, ignoreAttrs);
  if (attrs) out.attrs = attrs;
  if (node.marks && node.marks.length > 0) {
    out.marks = [...node.marks]
      .map((m) => ({ type: m.type, attrs: reduceAttrs(m.attrs, ignoreAttrs) }))
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  }
  if (node.content && node.content.length > 0)
    out.content = node.content.map((child) => reduce(child, ignoreAttrs));
  return out;
}

function reduceAttrs(
  attrs: Record<string, unknown> | undefined,
  ignoreAttrs?: (key: string) => boolean,
): Record<string, unknown> | null {
  if (!attrs) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    if (VOLATILE_ATTRS.has(key)) continue;
    if (ignoreAttrs?.(key)) continue;
    const value = attrs[key];
    if (value === undefined || value === null) continue;
    out[key] = ignoreAttrs ? deepDropKeys(value, ignoreAttrs) : value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Recursively strip every object key the predicate matches, at any depth.
 *  Only invoked when a caller passes `ignoreAttrs`; a plain comparison leaves
 *  attr values untouched. Object keys only — a matched string that appears as a
 *  VALUE (e.g. an mdast attribute `{ name: 'src', value }` whose key is `name`)
 *  is preserved, so the raw authored attribute survives while its
 *  render-derived projection is dropped. */
function deepDropKeys(value: unknown, ignoreAttrs: (key: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => deepDropKeys(entry, ignoreAttrs));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (ignoreAttrs(key)) continue;
      out[key] = deepDropKeys(entry, ignoreAttrs);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

/** Concatenated, whitespace-stripped text of a tree — the byte stream a
 *  faithful round-trip must not LOSE. Compared as a subsequence so a degrade
 *  that INSERTS tokens (a `<br/>` literal) never reads as loss. */
function textSkeleton(node: PmStructuralNode): string {
  let acc = '';
  const walk = (n: PmStructuralNode): void => {
    if (n.text !== undefined) acc += n.text;
    if (n.content) for (const child of n.content) walk(child);
  };
  walk(node);
  return acc.replace(/\s+/g, '');
}

/** Sorted multiset of container identities; `jsxComponent` carries its
 *  componentName so a same-count container substitution still diverges. */
function containerSignature(node: PmStructuralNode): string[] {
  const sig: string[] = [];
  const walk = (n: PmStructuralNode): void => {
    if (n.type && CONTAINER_TYPES.has(n.type)) {
      const name = n.type === 'jsxComponent' ? String(n.attrs?.componentName ?? '') : '';
      sig.push(name ? `${n.type}:${name}` : n.type);
    }
    if (n.content) for (const child of n.content) walk(child);
  };
  walk(node);
  return sig.sort();
}

function applyDegrades(tree: PmStructuralNode): {
  normalized: PmStructuralNode;
  fired: StructuralDegradeLabel[];
} {
  let current = tree;
  const fired: StructuralDegradeLabel[] = [];
  for (const entry of STRUCTURAL_DEGRADE_REGISTRY) {
    const before = stableStringify(current);
    const after = entry.canonicalize(current);
    if (stableStringify(after) !== before) fired.push(entry.label);
    current = after;
  }
  return { normalized: current, fired };
}


export function comparePmStructural(
  expected: PmStructuralNode,
  actual: PmStructuralNode,
  opts: ComparePmStructuralOptions = {},
): StructuralEquivalenceResult {
  const e = applyDegrades(expected);
  const a = applyDegrades(actual);
  const appliedDegrades = [...new Set([...e.fired, ...a.fired])];

  if (!isSubsequence(textSkeleton(e.normalized), textSkeleton(a.normalized))) {
    return {
      equivalent: false,
      level: 'L1',
      reason: 'content-loss',
      appliedDegrades,
      detail: 'authored text did not survive the round-trip',
    };
  }

  const expectedSig = containerSignature(e.normalized);
  const actualSig = containerSignature(a.normalized);
  if (stableStringify(expectedSig) !== stableStringify(actualSig)) {
    return {
      equivalent: false,
      level: 'L1',
      reason: 'structural-shatter',
      appliedDegrades,
      detail: `container multiset diverged: [${expectedSig.join(', ')}] vs [${actualSig.join(', ')}]`,
    };
  }

  const reducedExpected = reduce(e.normalized, opts.ignoreAttrs);
  const reducedActual = reduce(a.normalized, opts.ignoreAttrs);
  if (stableStringify(reducedExpected) === stableStringify(reducedActual)) {
    return {
      equivalent: true,
      level: appliedDegrades.length > 0 ? 'L2' : 'L1',
      appliedDegrades,
    };
  }
  return {
    equivalent: false,
    level: 'L2',
    reason: 'structural-divergence',
    appliedDegrades,
    detail: firstStructuralDivergence(reducedExpected, reducedActual),
  };
}

/** Best-effort locator naming the first structurally diverging node path — a
 *  red result should name the construct, not dump a tree. Falls back to a
 *  coarse message when the divergence is deep. */
function firstStructuralDivergence(expected: unknown, actual: unknown, path = 'doc'): string {
  const ex = expected as Record<string, unknown> | undefined;
  const ac = actual as Record<string, unknown> | undefined;
  if (!ex || !ac) return `${path}: node presence differs`;
  if (ex.type !== ac.type) return `${path}: type ${String(ex.type)} vs ${String(ac.type)}`;
  const exContent = (ex.content as unknown[]) ?? [];
  const acContent = (ac.content as unknown[]) ?? [];
  if (exContent.length !== acContent.length) {
    return `${path}(${String(ex.type)}): child count ${exContent.length} vs ${acContent.length}`;
  }
  for (let i = 0; i < exContent.length; i++) {
    if (stableStringify(exContent[i]) !== stableStringify(acContent[i])) {
      return firstStructuralDivergence(
        exContent[i],
        acContent[i],
        `${path}>${String(ex.type)}[${i}]`,
      );
    }
  }
  return `${path}(${String(ex.type)}): attrs or marks differ`;
}

export function compareRoundTripStructural(
  doc: PmStructuralNode,
  io: {
    serialize: (doc: PmStructuralNode) => string;
    parse: (body: string) => PmStructuralNode;
  },
  opts: ComparePmStructuralOptions = {},
): StructuralEquivalenceResult {
  let actual: PmStructuralNode;
  try {
    actual = io.parse(io.serialize(doc));
  } catch (err) {
    return {
      equivalent: false,
      level: 'L1',
      reason: 'pipeline-threw',
      appliedDegrades: [],
      detail: `serialize/parse threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return comparePmStructural(doc, actual, opts);
}

export function structuralDivergence(
  fromSource: PmStructuralNode,
  fromFragment: PmStructuralNode,
  ignoreAttrs?: (attrKey: string) => boolean,
): boolean {
  return !comparePmStructural(fromSource, fromFragment, { ignoreAttrs }).equivalent;
}
