/**
 * Overlap-aware styling for the anchor-highlight layer.
 *
 * ProseMirror concatenates the `style` attribute of overlapping inline
 * decorations onto the one span it splits out, so two comments on the same
 * words collapse to whichever decoration is emitted last — the second comment
 * silently vanishes from the document while still sitting in the panel. This
 * cuts the ranges into non-overlapping segments up front and emits a single
 * style per segment, so a passage two comments share can be styled for one of
 * them without the other's decoration overwriting it.
 *
 * Which one it's styled for is the active thread: the pale wash means "a
 * comment covers this", and deepening it on the thread you're reading is what
 * separates the two. One hue throughout — intensity, not color, carries the
 * distinction, so a document with many comments reads as one mark type.
 */

export interface PlacedAnchor {
  /** Thread this range belongs to; null for the composer's pending draft. */
  id: string | null;
  from: number;
  to: number;
}

export interface AnchorSegment {
  from: number;
  to: number;
  style: string;
  /** Narrowest thread covering the segment — what a click on it opens. */
  threadId: string | null;
}

/**
 * Blue, as an `r,g,b` triple for interpolation into `rgba()`.
 *
 * Yellow and red are reserved: lint and audit problems mark up passages in the
 * same body text, and the `==highlight==` mark is a yellow wash too — a comment
 * in amber was a third thing wearing the warning colour.
 *
 * Deeper than `--color-azure-blue`, which in-viewer find washes over its matches
 * at 30%. Sharing a family with find is the cost of blue; the underline below is
 * what separates them, since find paints a bare wash with no rule under it.
 *
 * The value is a CSS custom property, not a literal, because it is the one part
 * of the mark that must move with the theme — the alpha ladder below is painted
 * identically on both canvases, and no single blue clears the 3:1 non-text floor
 * at both ends. `globals.css` holds both values; the fallback here is the light
 * one, so an unstyled mount degrades to a visible mark rather than to
 * `rgba()` with a missing argument, which drops the highlight entirely.
 *
 * Exported because a property value's highlight cannot be a decoration — it is
 * painted as the field's own `::selection`, in `property-row-rect.ts`. Two
 * highlights meaning the same thing in two different colours would read as two
 * different states, so both in-document washes derive from here.
 *
 * The panel surfaces cannot: `ThreadCard` and `CommentMarginRail` are styled in
 * Tailwind, which takes class literals rather than an `rgb()` triple, so each
 * carries a hand-kept `blue-*` mirror. Recolouring means editing those two, this
 * fallback, and both `globals.css` declarations.
 */
export const COMMENT_HUE = 'var(--ok-comment-hue,37,99,235)';
const HUE = COMMENT_HUE;

/** Held at its pre-overlap value, so an unattended highlight is unchanged. */
const RESTING = { fill: 0.22, line: 0.7 };

/** Deep enough to read as a distinct band where it abuts a resting highlight. */
const ACTIVE = { fill: 0.45, line: 1 };

/** The active fill, for the `::selection` twin that cannot read this object. */
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

/**
 * The passage being composed on counts as active: while the composer is open
 * it's the thing under discussion, so it stands out from comments already made.
 */
function isActive(anchor: PlacedAnchor, activeId: string | null): boolean {
  return anchor.id === null || anchor.id === activeId;
}

/**
 * Split the placed ranges at every start/end boundary, keeping only the spans
 * some comment actually covers and merging back the neighbours that ended up
 * with an identical cover set.
 */
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
    // The active thread paints the span it shares with others; without an
    // active one the earliest-starting comment does, which for a lone highlight
    // is simply itself.
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
