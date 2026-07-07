import type { GraphNode } from './graph-view-utils';

export interface GraphLabelDescriptor {
  fullLabel: string;
  leadLabel: string | null;
  pathLabel: string;
  primaryLabel: string;
  topicLabel: string | null;
}

const SEGMENT_SPLIT_RE = /(?:\s+[—–|]\s+|:\s+)/;

export function buildGraphLabelDescriptors(nodes: GraphNode[]): Map<string, GraphLabelDescriptor> {
  const descriptors = new Map<string, GraphLabelDescriptor>();

  for (const node of nodes) {
    const fullLabel = normalizeLabel(node.label || node.id);
    const cleanedLabel = stripTrailingAsides(fullLabel);
    const pathSource = node.kind === 'doc' ? (node.docName ?? node.id) : (node.url ?? node.id);
    const pathLabel = compressPathLikeLabel(pathSource);
    const pathLikeLabel = looksPathLikeLabel(cleanedLabel);
    const primaryLabel = pathLikeLabel ? compressPathLikeLabel(cleanedLabel) : cleanedLabel;
    const segments = pathLikeLabel ? [] : splitStructuredSegments(cleanedLabel);
    const leadLabel = segments.length > 1 ? (segments[0] ?? null) : null;
    const topicLabel = segments.length > 1 ? (segments.at(-1) ?? null) : null;

    descriptors.set(node.id, {
      fullLabel,
      leadLabel:
        leadLabel && leadLabel !== primaryLabel && leadLabel !== topicLabel ? leadLabel : null,
      pathLabel,
      primaryLabel,
      topicLabel: topicLabel && topicLabel !== primaryLabel ? topicLabel : null,
    });
  }

  return descriptors;
}

export function pickGraphLabelText(
  descriptor: GraphLabelDescriptor | undefined,
  maxWidthPx: number,
  measureWidthPx: (text: string) => number,
): string {
  if (!descriptor) return '';

  const fits = (text: string) => measureWidthPx(text) <= maxWidthPx;

  for (const candidate of uniqueNonEmpty([descriptor.primaryLabel, descriptor.topicLabel])) {
    if (fits(candidate)) {
      return candidate;
    }
  }

  for (const candidate of uniqueNonEmpty([descriptor.topicLabel, descriptor.primaryLabel])) {
    const clamped = clampTextToWidth(candidate, maxWidthPx, measureWidthPx);
    if (clamped) {
      return clamped;
    }
  }

  if (descriptor.leadLabel && fits(descriptor.leadLabel)) {
    return descriptor.leadLabel;
  }

  if (descriptor.leadLabel) {
    const clampedLead = clampTextToWidth(descriptor.leadLabel, maxWidthPx, measureWidthPx);
    if (clampedLead) {
      return clampedLead;
    }
  }

  if (fits(descriptor.pathLabel)) {
    return descriptor.pathLabel;
  }

  return clampTextToWidth(descriptor.pathLabel, maxWidthPx, measureWidthPx) || descriptor.pathLabel;
}

function clampTextToWidth(
  text: string,
  maxWidthPx: number,
  measureWidthPx: (text: string) => number,
): string {
  if (!text) return '';
  if (measureWidthPx(text) <= maxWidthPx) return text;

  const words = text.split(/\s+/).filter(Boolean);
  const wordCandidates = uniqueNonEmpty([
    words.length >= 3 ? `${words.slice(0, 2).join(' ')} … ${words.at(-1) ?? ''}` : undefined,
    words.length >= 2 ? `${words[0]} … ${words.at(-1) ?? ''}` : undefined,
  ]);

  for (const candidate of wordCandidates) {
    if (measureWidthPx(candidate) <= maxWidthPx) {
      return candidate;
    }
  }

  return clampMiddleByCharacters(text, maxWidthPx, measureWidthPx);
}

function clampMiddleByCharacters(
  text: string,
  maxWidthPx: number,
  measureWidthPx: (text: string) => number,
): string {
  const ellipsis = '…';
  if (measureWidthPx(ellipsis) > maxWidthPx) {
    return '';
  }

  // Preference order — pick the most-readable fit:
  //   1. Word-boundary middle-clamp (`head… tail`, both sides at spaces)
  //   2. Word-boundary end-truncate (`head…`, head ends at a space)
  //   3. Character-level end-truncate (`head…`, head may end mid-word)
  // Mid-word middle-clamp (`Install…n guide`) is never produced — it reads
  // as garbled text. Walk keep values from largest down so we return the
  // longest readable candidate that fits.

  const maxKeep = Math.max(1, Math.floor((text.length - ellipsis.length) / 2));
  for (let keep = maxKeep; keep >= 1; keep--) {
    if (text[keep] !== ' ' || text[text.length - keep - 1] !== ' ') continue;
    const candidate = `${text.slice(0, keep)}${ellipsis}${text.slice(-keep)}`;
    if (measureWidthPx(candidate) <= maxWidthPx) return candidate;
  }

  for (let i = text.length - 1; i >= 1; i--) {
    if (text[i] !== ' ') continue;
    const candidate = `${text.slice(0, i)}${ellipsis}`;
    if (measureWidthPx(candidate) <= maxWidthPx) return candidate;
  }

  for (let n = text.length - 1; n >= 1; n--) {
    const candidate = `${text.slice(0, n)}${ellipsis}`;
    if (measureWidthPx(candidate) <= maxWidthPx) return candidate;
  }

  return measureWidthPx(ellipsis) <= maxWidthPx ? ellipsis : '';
}

function splitStructuredSegments(label: string): string[] {
  return normalizeLabel(label)
    .split(SEGMENT_SPLIT_RE)
    .map((segment) => normalizeLabel(segment))
    .filter(Boolean);
}

function stripTrailingAsides(label: string): string {
  let next = normalizeLabel(label);

  while (true) {
    const trimmed = next.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (!trimmed || trimmed === next) {
      return next;
    }
    next = trimmed;
  }
}

function looksPathLikeLabel(label: string): boolean {
  const slashCount = (label.match(/\//g) ?? []).length;
  const whitespaceCount = (label.match(/\s/g) ?? []).length;

  return slashCount > 0 && (whitespaceCount === 0 || slashCount * 3 > whitespaceCount);
}

function compressPathLikeLabel(label: string): string {
  const segments = label
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) return label;
  if (segments.length === 1) return condensePathSegment(segments[0]);

  const tail = segments.slice(-2).map(condensePathSegment);
  return tail.join(' / ');
}

function condensePathSegment(segment: string): string {
  if (segment.length <= 24) return segment;

  const slugParts = segment.split('-').filter(Boolean);
  if (slugParts.length >= 4) {
    const withoutLeadingNumbers = [...slugParts];
    while (withoutLeadingNumbers.length > 2 && /^\d+$/.test(withoutLeadingNumbers[0])) {
      withoutLeadingNumbers.shift();
    }
    if (withoutLeadingNumbers.length >= 2) {
      return withoutLeadingNumbers.slice(-3).join('-');
    }
  }

  return segment.length <= 24 ? segment : `${segment.slice(0, 10)}...${segment.slice(-10)}`;
}

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim();
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    unique.add(value);
  }
  return [...unique];
}
