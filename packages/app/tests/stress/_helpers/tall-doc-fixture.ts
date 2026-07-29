/**
 * Deterministic tall-document fixture for landing tests.
 *
 * A landing assertion is only honest if the target block is far enough down a
 * genuinely virtualized document that a wrong landing leaves it off-screen (and
 * content-visibility-skipped). This generator produces such a document plus a
 * block-inventory manifest the tests assert against, so a test can seed a doc,
 * ask for "block 200", and check the landing brought exactly that block into
 * view — with no coordinate math living in the test itself.
 *
 * Determinism: content is a pure function of the requested block count and
 * shifter list. `Math.random` is not used (it is unavailable in this repo's
 * workflow sandbox and would make replay impossible); filler words are drawn
 * from a fixed table indexed by block position.
 *
 * Every block is one top-level paragraph carrying a unique marker. The marker
 * is emphasised (`**OKBLK0042**`) so the rendered `.ok-chunk-wrapper` always
 * has an element child (`<strong>`): the content-visibility skip state a
 * WYSIWYG landing assertion reads is reported on the wrapper's first element
 * child, not the wrapper itself, so a plain-text paragraph (no element child)
 * would have nothing to probe.
 */

const MARKER_PREFIX = 'OKBLK';
const MARKER_DIGITS = 4;

/** Fixed lorem table — filler is drawn from here by block index, never randomly. */
const FILLER_WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'tempor',
  'incididunt',
  'labore',
  'magna',
  'aliqua',
  'veniam',
  'nostrud',
  'ullamco',
  'laboris',
  'aliquip',
  'commodo',
  'consequat',
] as const;

/**
 * The unique, greppable marker for a block index — `OKBLK0042`. Stable across
 * runs and shared by the generator, the manifest, and every assertion so a test
 * never hard-codes a marker string the generator could drift away from.
 */
export function blockMarker(index: number): string {
  return `${MARKER_PREFIX}${String(index).padStart(MARKER_DIGITS, '0')}`;
}

export interface TallDocBlock {
  /** 0-based position among the document's top-level body blocks. */
  index: number;
  /** The block's unique marker (`blockMarker(index)`). */
  marker: string;
}

export interface TallDocShifterSpec {
  /**
   * The shifter is inserted immediately after this block index, so its late
   * height growth pushes every block below it — including a landing target
   * placed further down — during the settle window.
   */
  afterBlock: number;
  /** How long the arming route holds the response before serving it. */
  delayMs?: number;
  /** Final rendered height once it resolves — the layout shift magnitude. */
  heightPx?: number;
}

export interface TallDocShifter {
  /** 0-based position among the document's shifters. */
  index: number;
  afterBlock: number;
  delayMs: number;
  heightPx: number;
  /**
   * The image src the shifter renders. An arming helper serves this path late
   * (with `delayMs`) to synthesize a deterministic async layout shift; unarmed,
   * it simply 404s and contributes no height.
   */
  url: string;
}

export interface TallDocManifest {
  /** Number of top-level paragraph blocks (excludes shifter image blocks). */
  blockCount: number;
  blocks: readonly TallDocBlock[];
  shifters: readonly TallDocShifter[];
}

export interface GenerateTallDocOptions {
  /** Number of top-level paragraph blocks to emit. */
  blockCount: number;
  /** Async layout shifters to interleave, each positioned after a block. */
  shifters?: readonly TallDocShifterSpec[];
}

const DEFAULT_SHIFTER_DELAY_MS = 300;
const DEFAULT_SHIFTER_HEIGHT_PX = 600;
/** Sentinel path prefix an arming helper matches with `page.route`. */
export const SHIFTER_URL_PREFIX = '/__ok-landing-shifter__';

function fillerFor(index: number): string {
  // Deterministic 12-word run whose starting offset rotates by block index, so
  // adjacent blocks read differently but the same index always reproduces.
  const count = 12;
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(FILLER_WORDS[(index * 7 + i * 3) % FILLER_WORDS.length] ?? 'lorem');
  }
  return words.join(' ');
}

/**
 * Build a tall markdown document and the manifest describing it. Blocks are
 * emitted in index order; each requested shifter is spliced in after its
 * `afterBlock` as its own image block. The returned markdown is ready to seed
 * through `api.seedDocs`; the manifest is what assertions target.
 */
export function generateTallDoc(options: GenerateTallDocOptions): {
  markdown: string;
  manifest: TallDocManifest;
} {
  const { blockCount } = options;
  if (!Number.isInteger(blockCount) || blockCount <= 0) {
    throw new Error(`generateTallDoc: blockCount must be a positive integer, got ${blockCount}`);
  }
  const shifterSpecs = options.shifters ?? [];

  const blocks: TallDocBlock[] = [];
  const shifters: TallDocShifter[] = [];
  const shiftersByBlock = new Map<number, TallDocShifterSpec[]>();
  for (const spec of shifterSpecs) {
    const list = shiftersByBlock.get(spec.afterBlock) ?? [];
    list.push(spec);
    shiftersByBlock.set(spec.afterBlock, list);
  }

  const segments: string[] = [];
  for (let i = 0; i < blockCount; i++) {
    const marker = blockMarker(i);
    blocks.push({ index: i, marker });
    segments.push(`**${marker}** ${fillerFor(i)}`);
    for (const spec of shiftersByBlock.get(i) ?? []) {
      const index = shifters.length;
      const shifter: TallDocShifter = {
        index,
        afterBlock: i,
        delayMs: spec.delayMs ?? DEFAULT_SHIFTER_DELAY_MS,
        heightPx: spec.heightPx ?? DEFAULT_SHIFTER_HEIGHT_PX,
        url: `${SHIFTER_URL_PREFIX}/${index}.png`,
      };
      shifters.push(shifter);
      segments.push(`![shifter-${index}](${shifter.url})`);
    }
  }

  return {
    markdown: segments.join('\n\n'),
    manifest: { blockCount, blocks, shifters },
  };
}
