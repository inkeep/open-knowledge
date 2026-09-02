export interface PlacedAnchor {
  id: string | null;
  from: number;
  to: number;
}

export interface AnchorSegment {
  from: number;
  to: number;
  style: string;
  threadId: string | null;
}

export const COMMENT_HUE = 'var(--ok-comment-hue,37,99,235)';
const HUE = COMMENT_HUE;

const RESTING = { fill: 0.22, line: 0.7 };

const ACTIVE = { fill: 0.45, line: 1 };

export const COMMENT_ACTIVE_FILL = 0.45;

function style(anchor: PlacedAnchor, active: boolean): string {
  const hue = HUE;
  const { fill, line } = active ? ACTIVE : RESTING;
  return [
    'border-radius:2px',
    'padding-bottom:1px',
    ...(anchor.id === null ? [] : ['cursor:pointer']),
    `background-color:rgba(${hue},${fill})`,
    `box-shadow:inset 0 -2px 0 rgba(${hue},${line})`,
    '',
  ].join(';');
}

function coverKey(covering: PlacedAnchor[]): string {
  return covering.map((a) => a.id ?? '·').join('|');
}

function narrowestThread(covering: PlacedAnchor[]): string | null {
  let best: PlacedAnchor | null = null;
  for (const anchor of covering) {
    if (anchor.id === null) continue;
    if (best === null || anchor.to - anchor.from < best.to - best.from) best = anchor;
  }
  return best?.id ?? null;
}

function isActive(anchor: PlacedAnchor, activeId: string | null): boolean {
  return anchor.id === null || anchor.id === activeId;
}

export function buildAnchorSegments(
  placed: PlacedAnchor[],
  activeId: string | null = null,
): AnchorSegment[] {
  const anchors = [...placed]
    .filter((a) => a.from < a.to)
    .sort((a, b) => a.from - b.from || a.to - b.to || (a.id ?? '').localeCompare(b.id ?? ''));
  if (anchors.length === 0) return [];

  const edges = [...new Set(anchors.flatMap((a) => [a.from, a.to]))].sort((x, y) => x - y);
  const segments: AnchorSegment[] = [];
  let open: { from: number; to: number; covering: PlacedAnchor[] } | null = null;

  const close = () => {
    if (open === null) return;
    const lead = open.covering.find((a) => isActive(a, activeId));
    segments.push({
      from: open.from,
      to: open.to,
      style: style(lead ?? open.covering[0], lead !== undefined),
      threadId: narrowestThread(open.covering),
    });
    open = null;
  };

  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    const covering = anchors.filter((a) => a.from <= from && a.to >= to);
    if (covering.length === 0) {
      close();
      continue;
    }
    if (open !== null && open.to === from && coverKey(open.covering) === coverKey(covering)) {
      open.to = to;
      continue;
    }
    close();
    open = { from, to, covering };
  }
  close();

  return segments;
}
