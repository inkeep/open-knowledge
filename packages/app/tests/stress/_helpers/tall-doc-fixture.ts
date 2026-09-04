const MARKER_PREFIX = 'OKBLK';
const MARKER_DIGITS = 4;

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

export function blockMarker(index: number): string {
  return `${MARKER_PREFIX}${String(index).padStart(MARKER_DIGITS, '0')}`;
}

export interface TallDocBlock {
  index: number;
  marker: string;
}

export interface TallDocShifterSpec {
  afterBlock: number;
  delayMs?: number;
  heightPx?: number;
}

export interface TallDocShifter {
  index: number;
  afterBlock: number;
  delayMs: number;
  heightPx: number;
  url: string;
}

export interface TallDocManifest {
  blockCount: number;
  blocks: readonly TallDocBlock[];
  shifters: readonly TallDocShifter[];
}

export interface GenerateTallDocOptions {
  blockCount: number;
  shifters?: readonly TallDocShifterSpec[];
}

const DEFAULT_SHIFTER_DELAY_MS = 300;
const DEFAULT_SHIFTER_HEIGHT_PX = 600;
export const SHIFTER_URL_PREFIX = '/__ok-landing-shifter__';

function fillerFor(index: number): string {
  const count = 12;
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(FILLER_WORDS[(index * 7 + i * 3) % FILLER_WORDS.length] ?? 'lorem');
  }
  return words.join(' ');
}

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
