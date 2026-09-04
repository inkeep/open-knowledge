import { diff3Merge } from 'node-diff3';

const MARKER_OURS = '<<<<<<< ours';
const MARKER_BASE = '||||||| original';
const MARKER_SEPARATOR = '=======';
const MARKER_THEIRS = '>>>>>>> theirs';

export function synthesiseConflictMarkers(
  ours: string,
  base: string | null | undefined,
  theirs: string,
  options: { includeBaseSection?: boolean } = {},
): string {
  return synthesiseConflictMarkersWithRegions(ours, base, theirs, options).text;
}

export interface SynthesisedConflictRegion {
  startLineIndex: number;
  baseMarkerLineIndex?: number;
  separatorLineIndex: number;
  endLineIndex: number;
}

export interface SynthesisedConflictMarkers {
  text: string;
  regions: SynthesisedConflictRegion[];
}

export function synthesiseConflictMarkersWithRegions(
  ours: string,
  base: string | null | undefined,
  theirs: string,
  options: { includeBaseSection?: boolean } = {},
): SynthesisedConflictMarkers {
  const { includeBaseSection = true } = options;
  if (base == null) {
    return twoWayBlock(ours, theirs);
  }

  const hasTrailing = ours.endsWith('\n') || base.endsWith('\n') || theirs.endsWith('\n');
  const dropTrailingEmpty = (lines: string[]): string[] =>
    lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  const oursLines = dropTrailingEmpty(ours.split('\n'));
  const baseLines = dropTrailingEmpty(base.split('\n'));
  const theirsLines = dropTrailingEmpty(theirs.split('\n'));

  const regions = diff3Merge(oursLines, baseLines, theirsLines);

  const parts: string[] = [];
  const written: SynthesisedConflictRegion[] = [];
  for (const region of regions) {
    if (region.ok) {
      parts.push(...region.ok);
    } else if (region.conflict) {
      const startLineIndex = parts.length;
      parts.push(MARKER_OURS);
      parts.push(...region.conflict.a);
      let baseMarkerLineIndex: number | undefined;
      if (includeBaseSection) {
        baseMarkerLineIndex = parts.length;
        parts.push(MARKER_BASE);
        parts.push(...region.conflict.o);
      }
      const separatorLineIndex = parts.length;
      parts.push(MARKER_SEPARATOR);
      parts.push(...region.conflict.b);
      const endLineIndex = parts.length;
      parts.push(MARKER_THEIRS);
      written.push({ startLineIndex, baseMarkerLineIndex, separatorLineIndex, endLineIndex });
    }
  }

  if (hasTrailing) parts.push('');
  return { text: parts.join('\n'), regions: written };
}

function twoWayBlock(ours: string, theirs: string): SynthesisedConflictMarkers {
  if (ours === theirs) return { text: ours, regions: [] };

  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');

  const hasTrailing = oursLines.at(-1) === '' || theirsLines.at(-1) === '';
  const oursContent = oursLines.at(-1) === '' ? oursLines.slice(0, -1) : oursLines;
  const theirsContent = theirsLines.at(-1) === '' ? theirsLines.slice(0, -1) : theirsLines;

  const parts: string[] = [MARKER_OURS, ...oursContent];
  const separatorLineIndex = parts.length;
  parts.push(MARKER_SEPARATOR, ...theirsContent);
  const endLineIndex = parts.length;
  parts.push(MARKER_THEIRS);
  if (hasTrailing) parts.push('');
  return {
    text: parts.join('\n'),
    regions: [{ startLineIndex: 0, separatorLineIndex, endLineIndex }],
  };
}
