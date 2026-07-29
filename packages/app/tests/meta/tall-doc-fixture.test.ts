import { describe, expect, test } from 'vitest';
import {
  blockMarker,
  type GenerateTallDocOptions,
  generateTallDoc,
  SHIFTER_URL_PREFIX,
  type TallDocBlock,
  type TallDocManifest,
  type TallDocShifter,
  type TallDocShifterSpec,
} from '../stress/_helpers/tall-doc-fixture.ts';

describe('tall-doc fixture generator', () => {
  test('emits one top-level block per requested block with a unique marker', () => {
    const opts: GenerateTallDocOptions = { blockCount: 40 };
    const { markdown, manifest } = generateTallDoc(opts);
    expect(manifest.blockCount).toBe(40);
    expect(manifest.blocks).toHaveLength(40);

    const topLevelBlocks = markdown.split('\n\n');
    expect(topLevelBlocks).toHaveLength(40);

    const blocks: readonly TallDocBlock[] = manifest.blocks;
    const markers = blocks.map((b) => b.marker);
    expect(new Set(markers).size).toBe(40);
    for (const block of manifest.blocks) {
      expect(block.marker).toBe(blockMarker(block.index));
      // The marker must appear verbatim in the rendered source so an assertion
      // can locate the block by text in either editor.
      expect(markdown).toContain(block.marker);
    }
  });

  test('block markers are zero-padded and stable across regeneration', () => {
    expect(blockMarker(0)).toBe('OKBLK0000');
    expect(blockMarker(42)).toBe('OKBLK0042');
    expect(blockMarker(1234)).toBe('OKBLK1234');
    const a = generateTallDoc({ blockCount: 10 });
    const b = generateTallDoc({ blockCount: 10 });
    expect(a.markdown).toBe(b.markdown);
  });

  test('every block marker is emphasised so the rendered block has an element child', () => {
    const { markdown } = generateTallDoc({ blockCount: 5 });
    for (let i = 0; i < 5; i++) {
      expect(markdown).toContain(`**${blockMarker(i)}**`);
    }
  });

  test('positioned shifters are spliced after their block and recorded with a deterministic delay', () => {
    const specs: readonly TallDocShifterSpec[] = [
      { afterBlock: 2, delayMs: 250, heightPx: 800 },
      { afterBlock: 4 },
    ];
    const { markdown, manifest } = generateTallDoc({ blockCount: 6, shifters: specs });

    const shifters: readonly TallDocShifter[] = manifest.shifters;
    expect(shifters).toHaveLength(2);
    const [first, second] = shifters;
    expect(first?.afterBlock).toBe(2);
    expect(first?.delayMs).toBe(250);
    expect(first?.heightPx).toBe(800);
    expect(first?.url.startsWith(SHIFTER_URL_PREFIX)).toBe(true);
    // Unspecified delay/height fall back to deterministic defaults, never random.
    expect(second?.delayMs).toBeGreaterThan(0);
    expect(second?.heightPx).toBeGreaterThan(0);

    // The shifter image renders immediately after its block and before the next.
    const blockThreeStart = markdown.indexOf(blockMarker(3));
    const shifterMarkup = markdown.indexOf(`(${first?.url})`);
    const blockTwoStart = markdown.indexOf(blockMarker(2));
    expect(shifterMarkup).toBeGreaterThan(blockTwoStart);
    expect(shifterMarkup).toBeLessThan(blockThreeStart);
  });

  test('shifter block count is separate from the paragraph block count', () => {
    const { manifest } = generateTallDoc({
      blockCount: 3,
      shifters: [{ afterBlock: 0 }, { afterBlock: 1 }],
    });
    expect(manifest.blockCount).toBe(3);
    expect(manifest.blocks).toHaveLength(3);
    expect(manifest.shifters).toHaveLength(2);
  });

  test('rejects a non-positive block count rather than emitting an empty doc', () => {
    expect(() => generateTallDoc({ blockCount: 0 })).toThrow(/positive integer/);
    expect(() => generateTallDoc({ blockCount: -3 })).toThrow(/positive integer/);
  });

  test('manifest is a plain data record safe to assert against', () => {
    const { manifest } = generateTallDoc({ blockCount: 2 });
    // No functions on the manifest — tests assert on values, and the shape
    // survives a structured-clone round trip (e.g. crossing an evaluate boundary).
    const roundTripped = structuredClone(manifest) as TallDocManifest;
    expect(roundTripped).toEqual(manifest);
  });
});
