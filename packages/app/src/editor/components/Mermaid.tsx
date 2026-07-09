/**
 * MermaidView — DIY renderer for the canonical `<Mermaid>` block descriptor.
 *
 * Mermaid is browser-only (no first-party SSR per upstream issue #3650),
 * which fits OK's Vite + React 19 client perfectly. The library is lazy-
 * imported on first mount to keep the editor's first-load JS unaffected
 * for documents without diagrams; cost at first diagram is ~150 KB
 * gzipped (entry ~11 KB + lazy diagram-type chunks 24-45 KB each).
 *
 * `mermaid.render(id, chart)` is async and returns `{ svg }`. We
 * generate a unique id per render, await the result, and inject the SVG
 * via `dangerouslySetInnerHTML`. `securityLevel: 'strict'` (the default)
 * keeps Mermaid from emitting scripts inside the SVG; the storage layer
 * is unchanged either way (chart source is the prop value, render output
 * is rebuilt every mount).
 *
 * On parse error: Mermaid throws a synchronous error from `parse()` and
 * an async rejection from `render()`. We render the chart source verbatim
 * inside a tagged error chrome (red border + tooltip) so authors see
 * what they typed and can fix it. Co-editor DoS via malformed mermaid is
 * not a concern — error path stays inside the React boundary.
 *
 * Why this is a module-level Promise + `useEffect` instead of `React.lazy`
 * + `<Suspense>` (the pattern Math.tsx uses): KaTeX's `renderToString` is
 * synchronous after the module loads, so a single `lazy()` covers both
 * import resolution and render. Mermaid's `mermaid.render(id, chart)` is
 * async per call (it builds DOM scratch, runs layout, returns the SVG
 * string), so wrapping the import in `lazy()` would only cover the load
 * phase — every render still needs its own async await + cancellation
 * guard. The module-level Promise gives one cached load and the
 * `useEffect` gives per-render await + cancel-on-unmount, which matches
 * the actual two-phase shape. Don't normalize this to match Math.tsx
 * without addressing the per-render async work.
 *
 * ── Inline text editing ─────────────────────────────────────────────────
 *
 * Clicking any text in a rendered diagram — flowchart node label, edge
 * label, sequence-diagram message body, or sequence-diagram participant
 * — enters an in-place edit for just that piece of text. A plain
 * `<input>` is portalled to `document.body` (so ProseMirror never sees
 * it) and positioned over the clicked label; Enter commits, Escape
 * reverts, clicking away commits. On commit we splice the new value
 * back into the chart source and dispatch one `setNodeMarkup` with
 * `sourceDirty: true` (mirroring `Embed.tsx`'s resize-commit path).
 * Mermaid then re-renders the SVG from the updated source.
 *
 * Scope: flowchart node + edge labels, sequence message text, sequence
 * participants. Class / state / gantt / mindmap diagrams don't wire up
 * yet — clicking those falls through to the wrapper's normal
 * NodeSelection.
 *
 * Sequence participant renames PRESERVE the id: `participant Author`
 * becomes `participant Author as Alice`, so `Author->>Editor:` arrows
 * keep resolving.
 *
 * The find is exact-string against the CURRENT chart (re-read fresh
 * inside the commit handler, not closure-captured), so remote CRDT
 * edits that arrived between click and commit don't desync. If the
 * label was mermaid-quoted with entity refs (e.g. `#quot;`), the DOM
 * shows the decoded form but the source has the encoded form and no
 * match will be found — click silently no-ops in that case (rare).
 *
 * Why a portalled `<input>` and not a `contentEditable` label: PM's
 * MutationObserver reacts to any DOM change inside its editor tree by
 * re-syncing to its own model, which surfaces as page jumps and focus
 * loss on the first keystroke. Mounting the input outside PM's DOM is
 * what actually stops that reaction. The position anchor is the
 * enclosing visual box (label `<p>` for flowchart labels, actor
 * `<rect>` for participants) so `text-align: center` centers the text
 * at the shape's visual center, not the tight glyph bbox.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import type { default as PanZoomNS, PanzoomObject } from '@panzoom/panzoom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { default as MermaidNS } from 'mermaid';
import { type ComponentProps, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils.ts';
import { useJsxComponentHost } from './jsx-host-context.tsx';

// MermaidFence descriptor declares a single `chart` prop. `id` and `theme`
// are absent because neither is expressible in ` ```mermaid ` fence syntax,
// and no production code path can thread them to this component (the
// promoter emits `{chart}` only). Re-adding either to this interface would
// create a parallel render-side surface that nothing reaches.
/**
 * Read/write binding for the chart source that backs inline WYSIWYG editing.
 * Decouples `MermaidView` from its edit host so the SAME label-splice machinery
 * serves two surfaces: a codefenced ` ```mermaid ` fence (source lives on a
 * TipTap `jsxComponent` node) and a standalone `.mmd` doc (source is a CRDT
 * `Y.Text`). `getChart` is read live at commit time (never closure-captured) so
 * a concurrent peer edit between click and commit doesn't desync.
 */
export interface MermaidSourceBinding {
  canEdit: boolean;
  getChart: () => string;
  commitChart: (next: string) => void;
}

interface MermaidProps {
  chart?: string;
  className?: string;
  /**
   * When provided, inline editing writes back through this binding instead of
   * the JSX-component host (the standalone `.mmd` doc path). Absent for
   * codefenced fences, which derive the binding from `useJsxComponentHost()`.
   */
  editBinding?: MermaidSourceBinding;
}

interface RenderState {
  status: 'idle' | 'rendering' | 'ready' | 'error';
  svg: string;
  error: string;
}

const MERMAID_ZOOM_MIN = 0.5;
const MERMAID_ZOOM_MAX = 4;
const MERMAID_ZOOM_STEP = 0.25;
const MERMAID_PAN_STEP = 48;
const buttonProps: ComponentProps<typeof Button> = {
  type: 'button',
  size: 'icon-sm',
  variant: 'secondary',
  className: 'border-border',
};

/**
 * One-time initialization. Called lazily on the first render attempt so
 * documents without Mermaid pay nothing. Subsequent calls are no-ops via
 * the module-level guard.
 */
let mermaidPromise: Promise<typeof MermaidNS> | null = null;
function loadMermaid() {
  mermaidPromise ||= import('mermaid')
    .then((mod) => mod.default)
    .catch((err) => {
      // Clear the cached rejection so the next mount can retry. Without
      // this, a transient network failure during the first import would
      // disable Mermaid for the entire session — every subsequent
      // `loadMermaid()` would resolve to the cached rejected promise.
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

/**
 * Read the app's active color mode from the `<html>` class list — the
 * theme provider sets `.dark` / `.light` on `documentElement`; that's
 * also what `useApplyConfigTheme` writes and what `useThemeBridge`
 * exposes. Falling back to `prefers-color-scheme` covers the pre-mount
 * / SSR window, but the class is authoritative once the app is up.
 */
function readDocumentColorMode(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    const cls = document.documentElement.classList;
    if (cls.contains('dark')) return 'dark';
    if (cls.contains('light')) return 'light';
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

/**
 * Mermaid's built-in `dark` theme covers node fills and text but leaves
 * sequence-diagram notes on a hardcoded pastel yellow (`#EDF2AE`) that
 * clashes on a dark background, and its actor-box colors read as bright
 * white. Override the load-bearing `themeVariables` so notes, actors,
 * labels, and arrow signals track the OK dark palette. Values are
 * intentionally plain hex — mermaid derives contrast colors from these
 * strings and CSS variables don't survive its color-math step.
 */
const MERMAID_DARK_THEME_VARIABLES = {
  // Match OK's mono-ish design language rather than mermaid's default
  // Trebuchet MS. The stack tracks common OS monospace faces used by
  // the surrounding editor UI.
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  // Nodes + primaries (flowchart cores, actor boxes).
  background: '#0b0b0d',
  primaryColor: '#1c1c1f',
  primaryTextColor: '#f5f5f7',
  primaryBorderColor: '#2a2a2e',
  secondaryColor: '#242427',
  secondaryTextColor: '#f5f5f7',
  secondaryBorderColor: '#2a2a2e',
  tertiaryColor: '#2c2c30',
  tertiaryTextColor: '#f5f5f7',
  tertiaryBorderColor: '#2a2a2e',
  mainBkg: '#1c1c1f',
  // Edges and connectors — muted grey. Mermaid's built-in `dark` theme
  // pins these near-white, which reads as a set of harsh white lines
  // stitched across a dark canvas; the reference styling uses a dim
  // grey for every non-content stroke.
  lineColor: '#5a5a63',
  textColor: '#f5f5f7',
  // Sequence-diagram actors + arrows.
  actorBkg: '#1c1c1f',
  actorBorder: '#2a2a2e',
  actorTextColor: '#f5f5f7',
  actorLineColor: '#4a4a52',
  signalColor: '#8b8b93',
  signalTextColor: '#a1a1a9',
  // alt / opt / loop group chrome — dashed borders + label pill.
  labelBoxBkgColor: '#1c1c1f',
  labelBoxBorderColor: '#4a4a52',
  labelTextColor: '#a1a1a9',
  loopTextColor: '#a1a1a9',
  // Flowchart-specific overrides. Mermaid's default `dark` theme paints
  // `.node rect` with a near-white border via `nodeBorder`; the
  // reference styling wants the node fill to read as a single dark
  // shape with no visible outline. Cluster (subgraph) fills track the
  // same tone so nested clusters read as tiers not colored boxes.
  nodeBorder: '#1c1c1f',
  clusterBkg: '#141416',
  clusterBorder: '#2a2a2e',
  defaultLinkColor: '#5a5a63',
  edgeLabelBackground: '#0b0b0d',
  titleColor: '#a1a1a9',
  // Sequence-diagram Note over/left of/right of. A bold amber solid
  // reads as an intentional callout on a dark canvas — matches the
  // reference styling far better than the muted brown from the first
  // pass here.
  noteBkgColor: '#c88a1e',
  noteTextColor: '#ffffff',
  noteBorderColor: '#c88a1e',
  // Activation (self-arrow) chrome.
  activationBkgColor: '#2c2c30',
  activationBorderColor: '#3a3a40',
} as const;

/**
 * Mermaid's global `initialize` is the only place theme flows in — the
 * `render` API doesn't take per-call config. Call this immediately
 * before every `render()` so the SVG picks up the current app mode.
 * Idempotent: re-initializing with the same options is cheap.
 */
function configureMermaid(m: typeof MermaidNS, colorMode: 'light' | 'dark'): void {
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: colorMode === 'dark' ? 'dark' : 'default',
    themeVariables: colorMode === 'dark' ? MERMAID_DARK_THEME_VARIABLES : undefined,
    suppressErrorRendering: true,
  });
}

let panzoomPromise: Promise<typeof PanZoomNS> | null = null;
function loadPanzoom() {
  panzoomPromise ||= import('@panzoom/panzoom')
    .then((mod) => mod.default)
    .catch((err) => {
      panzoomPromise = null;
      throw err;
    });
  return panzoomPromise;
}

// ── Node-label source-splicing helpers ─────────────────────────────────

// Mermaid flowchart shape delimiters, ordered by open-length DESC so
// `((` matches before `(`, `[[` before `[`, etc. Otherwise the shorter
// prefix wins and steals the label from the wider shape.
const SHAPES: ReadonlyArray<{ open: string; close: string }> = [
  { open: '[[', close: ']]' },
  { open: '[(', close: ')]' },
  { open: '((', close: '))' },
  { open: '{{', close: '}}' },
  { open: '[/', close: '/]' },
  { open: '[\\', close: '\\]' },
  { open: '[/', close: '\\]' },
  { open: '[\\', close: '/]' },
  { open: '[', close: ']' },
  { open: '(', close: ')' },
  { open: '{', close: '}' },
  { open: '>', close: ']' },
];

export interface LabelMatch {
  start: number;
  end: number;
  wasQuoted: boolean;
  open: string;
  close: string;
}

/**
 * Locate the `<nodeId><shape>currentLabel<shape>` span in `source`.
 * Returns the range of the label text between the shape delimiters
 * (INCLUDING surrounding quotes when the source used the quoted form),
 * or null if no unambiguous match is found.
 *
 * We search exact-string against the trimmed DOM label. If the source
 * used mermaid entity refs like `#quot;` the raw source form and the
 * DOM form diverge and this returns null — caller silently no-ops.
 */
export function findLabelInSource(
  source: string,
  nodeId: string,
  currentLabel: string,
): LabelMatch | null {
  for (const { open, close } of SHAPES) {
    // Try quoted first — quoting means author explicitly opted into
    // preserving special chars, so if both quoted and unquoted forms are
    // present, the quoted one is the authored intent.
    for (const quoted of [true, false]) {
      const inner = quoted ? `"${currentLabel}"` : currentLabel;
      const fragment = `${nodeId}${open}${inner}${close}`;
      const idx = source.indexOf(fragment);
      if (idx < 0) continue;
      // Boundary: preceding char must be non-word (arrow, whitespace,
      // pipe, edge close, or line start) so we don't match `AB[Label]`
      // when looking for id `B`.
      const prev = idx === 0 ? '' : source.charAt(idx - 1);
      if (prev && /\w/.test(prev)) continue;
      const labelStart = idx + nodeId.length + open.length;
      const labelEnd = labelStart + inner.length;
      return {
        start: labelStart,
        end: labelEnd,
        wasQuoted: quoted,
        open,
        close,
      };
    }
  }
  return null;
}

function labelNeedsQuoting(label: string): boolean {
  // Any mermaid-syntactic char in the new label → wrap in quotes so the
  // parser sees it as a literal instead of shape/arrow syntax. Newline
  // isn't allowed inside unquoted labels either.
  return /[[\](){}|;#<>&\n"]/.test(label);
}

export function spliceNewLabel(source: string, match: LabelMatch, newLabel: string): string {
  // Only surfaces with shape delimiters (`[`, `(`, `{`, ...) accept
  // quoted labels — flowchart node shapes. Sequence-diagram messages
  // and edge labels have `open === ''` because they don't get a shape:
  // sequence messages are free text after `:`, and edge labels are
  // delimiter-bounded by pipes / arrow dashes. Auto-quoting there
  // renders LITERAL `"..."` in the diagram (e.g. editing a sequence
  // message to `Status [OK]` used to produce `"Status [OK]"` with
  // visible quotes).
  const shouldQuote = match.wasQuoted || (match.open !== '' && labelNeedsQuoting(newLabel));
  // Encode quotes as mermaid's entity ref so the label stays inside its
  // own quoted region.
  const escaped = newLabel.replace(/"/g, '#quot;');
  const replacement = shouldQuote ? `"${escaped}"` : newLabel;
  return source.slice(0, match.start) + replacement + source.slice(match.end);
}

/**
 * Pull the source node id out of a mermaid-rendered `.node` element id.
 * Format: `mermaid-<renderScope>-flowchart-<sourceId>-<counter>`. The
 * `flowchart-` prefix is emitted for `graph`/`flowchart` diagrams; other
 * diagram types don't carry `.node` elements, so this scope is fine.
 */
export function extractSourceNodeId(elementId: string): string | null {
  const m = /flowchart-(.+)-\d+$/.exec(elementId);
  return m ? m[1] : null;
}

export interface EdgeInfo {
  from: string;
  to: string;
  index: number;
}

/**
 * Pull `{from, to, index}` out of an edge-label's `data-id` attribute.
 * Format: `L_<from>_<to>_<counter>` — mermaid emits this on the inner
 * `<g class="label">` element inside a `.edgeLabel` group.
 */
export function extractEdgeInfo(dataId: string): EdgeInfo | null {
  // Underscores may appear inside from/to (rare) — match greedily on the
  // trailing counter and split the rest by the last remaining underscore.
  const m = /^L_(.+)_(\d+)$/.exec(dataId);
  if (!m) return null;
  const body = m[1];
  const index = Number(m[2]);
  const underscore = body.lastIndexOf('_');
  if (underscore < 0) return null;
  return {
    from: body.slice(0, underscore),
    to: body.slice(underscore + 1),
    index,
  };
}

/**
 * Locate an edge-label span in `source`. Handles the two most common
 * mermaid flowchart edge-label forms:
 *   1. Pipe form:   `A -->|label| B`      (or `-.->`, `==>`, `~~~>`)
 *   2. Inline form: `A -- label --> B`    (or `A --label--> B`)
 * Both quoted (`"..."`) and unquoted. Arrow variants: `-->`, `==>`,
 * `-.->`, `-.-`, `~~~`. Skips as many prior occurrences as `index`
 * requests so parallel edges between the same pair map to the right
 * source span.
 *
 * Returns the label text span (excluding pipes / delimiter dashes) so
 * `spliceNewLabel` can reuse the same replacement machinery as node
 * labels.
 */
export function findEdgeLabelInSource(
  source: string,
  fromId: string,
  toId: string,
  index: number,
  currentLabel: string,
): LabelMatch | null {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const f = esc(fromId);
  const t = esc(toId);
  const l = esc(currentLabel);
  // Arrow body: dash/equal/tilde runs, optional dotted, optional label-
  // ending head. Match generously since we anchor on labels.
  const arrowHead = '(?:-->|==>|-\\.->|~~~>|<--)';
  const arrowBody = '(?:--|==|-\\.|~~~)';
  const patterns: { re: RegExp; quoted: boolean; groupIndex: number }[] = [
    // A -->|"label"| B   — pipe form, quoted
    {
      re: new RegExp(`${f}\\s*${arrowBody}[->=]*\\s*\\|\\s*("${l}")\\s*\\|\\s*${t}`, 'gd'),
      quoted: true,
      groupIndex: 1,
    },
    // A -->|label| B     — pipe form, unquoted
    {
      re: new RegExp(`${f}\\s*${arrowBody}[->=]*\\s*\\|\\s*(${l})\\s*\\|\\s*${t}`, 'gd'),
      quoted: false,
      groupIndex: 1,
    },
    // A -- "label" --> B — inline form, quoted
    {
      re: new RegExp(`${f}\\s*${arrowBody}\\s*("${l}")\\s*${arrowHead}\\s*${t}`, 'gd'),
      quoted: true,
      groupIndex: 1,
    },
    // A -- label --> B   — inline form, unquoted
    {
      re: new RegExp(`${f}\\s*${arrowBody}\\s*(${l})\\s*${arrowHead}\\s*${t}`, 'gd'),
      quoted: false,
      groupIndex: 1,
    },
  ];
  // Gather every match across all four patterns, then sort by source
  // position so `index` maps to source order — matching mermaid's
  // `L_<from>_<to>_<counter>` numbering, which follows the arrow's
  // definition order in source. A naive per-pattern accumulator (the
  // earlier version) picked the wrong parallel edge when the source
  // mixed quoting styles: pattern-order walked all quoted matches
  // first, so `index=0` grabbed a quoted edge even when the DOM
  // `L_A_B_0` referred to the earlier unquoted one.
  //
  // The regex `d` (hasIndices) flag gives us exact capture-group
  // offsets from `m.indices[groupIndex]`, dodging a `m[0].indexOf(label)`
  // hunt that would misfire when the label text also appears earlier
  // in the match (e.g. `A -->|A| B` — fromId and label both "A").
  const matches: { start: number; end: number; wasQuoted: boolean }[] = [];
  for (const { re, quoted, groupIndex } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(source);
    while (m) {
      const groupRange = m.indices?.[groupIndex];
      if (groupRange) {
        matches.push({ start: groupRange[0], end: groupRange[1], wasQuoted: quoted });
      }
      m = re.exec(source);
    }
  }
  matches.sort((a, b) => a.start - b.start);
  const chosen = matches[index];
  if (!chosen) return null;
  return { start: chosen.start, end: chosen.end, wasQuoted: chosen.wasQuoted, open: '', close: '' };
}

/**
 * Locate a sequence-diagram message body in source. Sequence messages
 * live on lines like `Actor1->>Actor2: message text` (or `-->>`, `-x`,
 * `-)`, etc). The message body — everything after the `:` and one
 * required space — is what mermaid renders as `.messageText`.
 *
 * We match on the message text alone since mermaid's SVG doesn't expose
 * the actor pair on the `<text>` element. That's fine when the message
 * text is unique in the chart; when it isn't, `occurrence` picks which
 * one (0-indexed, from top of source).
 */
export function findSequenceMessageInSource(
  source: string,
  currentMessage: string,
  occurrence = 0,
): LabelMatch | null {
  const esc = currentMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `:` then at least one whitespace, then the message body up to
  // end-of-line. Multiline so `$` matches line boundaries. `d` flag so
  // we can read the exact capture-group offset without hunting via
  // `indexOf` (which would misfire if the message text also appears in
  // the arrow prefix).
  const re = new RegExp(`:[ \\t]+(${esc})[ \\t]*(?=\\r?\\n|$)`, 'gmd');
  let seen = 0;
  let m: RegExpExecArray | null = re.exec(source);
  while (m) {
    if (seen === occurrence) {
      const groupRange = m.indices?.[1];
      if (!groupRange) return null;
      const [labelStart, labelEnd] = groupRange;
      return {
        start: labelStart,
        end: labelEnd,
        wasQuoted: false,
        open: '',
        close: '',
      };
    }
    seen += 1;
    m = re.exec(source);
  }
  return null;
}

/**
 * Rewrite a sequence-diagram participant's display name in source.
 *
 * Handles all three supported source forms:
 *   1. `participant Author`               (bare — display doubles as id)
 *   2. `participant A as Author`          (aliased, unquoted display)
 *   3. `participant A as "Author"`        (aliased, quoted display)
 *
 * The `actor` keyword variant maps to the same three shapes.
 *
 * Aliased forms (2, 3) are pure replacements of the display span. Case
 * 1 is different: naively rewriting `participant Author` to
 * `participant Alice` would also break every `Author->>` arrow that
 * references the id. Instead we ADD an `as "..."` alias so the id
 * stays intact and only the display changes.
 *
 * Returns the new source, or null when no participant statement
 * matches the display name.
 */
export function rewriteSequenceParticipant(
  source: string,
  currentDisplay: string,
  newDisplay: string,
  occurrence = 0,
): string | null {
  const esc = currentDisplay.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedNew = newDisplay.replace(/"/g, '#quot;');

  interface Match {
    range: [number, number];
    replacement: string;
  }
  const findMatch = (re: RegExp, mkReplacement: (m: RegExpExecArray) => string): Match | null => {
    let seen = 0;
    re.lastIndex = 0;
    let m = re.exec(source);
    while (m) {
      if (seen === occurrence) {
        return { range: [m.index, m.index + m[0].length], replacement: mkReplacement(m) };
      }
      seen += 1;
      m = re.exec(source);
    }
    return null;
  };

  const kw = '(?:participant|actor)';

  // Aliased, quoted: `participant Id as "Display"`. If the new display
  // equals the id, collapse back to bare so we don't leave a redundant
  // `X as X` in the source.
  const rQuoted = new RegExp(
    `^([ \\t]*${kw}[ \\t]+)(\\S+)([ \\t]+as[ \\t]+")${esc}(")([ \\t]*)$`,
    'gm',
  );
  const mQuoted = findMatch(rQuoted, (m) => {
    const idToken = m[2];
    if (newDisplay === idToken) return `${m[1]}${idToken}${m[5]}`;
    return `${m[1]}${idToken}${m[3]}${escapedNew}${m[4]}${m[5]}`;
  });
  if (mQuoted)
    return source.slice(0, mQuoted.range[0]) + mQuoted.replacement + source.slice(mQuoted.range[1]);

  // Aliased, unquoted: `participant Id as Display`. Same collapse rule
  // as the quoted variant when the new display matches the id.
  const rUnquoted = new RegExp(
    `^([ \\t]*${kw}[ \\t]+)(\\S+)([ \\t]+as[ \\t]+)${esc}([ \\t]*)$`,
    'gm',
  );
  const mUnquoted = findMatch(rUnquoted, (m) => {
    const idToken = m[2];
    if (newDisplay === idToken) return `${m[1]}${idToken}${m[4]}`;
    const rendered = labelNeedsQuoting(newDisplay) ? `"${escapedNew}"` : newDisplay;
    return `${m[1]}${idToken}${m[3]}${rendered}${m[4]}`;
  });
  if (mUnquoted)
    return (
      source.slice(0, mUnquoted.range[0]) + mUnquoted.replacement + source.slice(mUnquoted.range[1])
    );

  // Bare: `participant Display` — the display IS the id, referenced
  // elsewhere via `Display->>Other`, so preserve it and add an
  // `as "New"` alias instead of overwriting. Quoting rule unified with
  // the aliased variants: whitespace is safe in a participant alias
  // (mermaid reads the alias to end of line), so only quote when the
  // new label contains an actual mermaid-syntactic delimiter.
  const rBare = new RegExp(`^([ \\t]*${kw}[ \\t]+)${esc}([ \\t]*)$`, 'gm');
  const mBare = findMatch(rBare, (m) => {
    const rendered = labelNeedsQuoting(newDisplay) ? `"${escapedNew}"` : newDisplay;
    return `${m[1]}${currentDisplay}${m[2]} as ${rendered}`;
  });
  if (mBare)
    return source.slice(0, mBare.range[0]) + mBare.replacement + source.slice(mBare.range[1]);

  return null;
}

/**
 * Locate a bare-id flowchart node reference in `source`. Used when the
 * DOM label equals the node id AND `findLabelInSource` returned null —
 * that combination means the author wrote the node without a shape
 * (`Shopper --> Storefront`) so the id renders as its own label.
 *
 * Returns the range of the id token to rewrite (the id stays, the label
 * gets APPENDED as `[NewLabel]` in `spliceInsertBareIdLabel` — keeping
 * the id preserves every `Shopper -->` arrow elsewhere in the chart).
 */
export function findFlowchartBareIdInSource(source: string, nodeId: string): LabelMatch | null {
  const esc = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Bare id: not preceded by a word char (so `AB` doesn't match id
  // `B`), and NOT followed by any character that starts a mermaid
  // shape or id extension. The negative lookahead rejects the shape
  // openers `[`, `(`, `{`, `<`, `>` (all valid mermaid shape starts),
  // any word char (would extend the id), and `@`/`:` (namespaced ids).
  // What CAN follow: whitespace, arrow heads (`-`, `=`, `.`, `~`,
  // `x`, `o`, `|`), semicolon, comma, or line end — none of those are
  // in the negative lookahead.
  const re = new RegExp(`(?<![\\w])${esc}(?![\\w[({<>@:])`, 'gd');
  const m = re.exec(source);
  if (!m) return null;
  const range = m.indices?.[0];
  if (!range) return null;
  return { start: range[0], end: range[1], wasQuoted: false, open: '', close: '' };
}

/**
 * Rewrite a bare-id flowchart reference to `<id>[NewLabel]`. Preserves
 * the id token verbatim; only inserts the shape+label after it, so
 * arrows referencing the id keep resolving.
 *
 * Auto-quotes `NewLabel` when it contains mermaid-syntactic chars
 * (matches `spliceNewLabel`'s policy). Encodes double-quotes as the
 * mermaid entity ref `#quot;`.
 */
export function spliceInsertBareIdLabel(
  source: string,
  match: LabelMatch,
  newLabel: string,
): string {
  const escaped = newLabel.replace(/"/g, '#quot;');
  const shouldQuote = labelNeedsQuoting(newLabel);
  const shape = shouldQuote ? `["${escaped}"]` : `[${newLabel}]`;
  // `match` is the id token itself; append the shape directly after it.
  return source.slice(0, match.end) + shape + source.slice(match.end);
}

/**
 * Locate a sequence-diagram `Note over|left of|right of <actors>: <text>`
 * line in `source`. Returns the range of the note body (the text after
 * the colon-space), or null if no unambiguous match is found.
 *
 * The DOM `.noteText` only exposes the body — actor participation and
 * position (`over`/`left of`/`right of`) live in the source line only,
 * so the search matches on the note body across all three note kinds
 * and disambiguates identical bodies via `occurrence`.
 */
export function findSequenceNoteInSource(
  source: string,
  currentNote: string,
  occurrence = 0,
): LabelMatch | null {
  const esc = currentNote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `Note (over|left of|right of) <actors>: <body>` — actors segment
  // stops at the first `:` (mermaid syntax; actor names can't contain
  // colons). The body captures up to end-of-line, trimmed. `d` flag
  // exposes the capture-group offset.
  const re = new RegExp(
    `^[ \\t]*Note[ \\t]+(?:over|left of|right of)[ \\t]+[^:\\n]+:[ \\t]+(${esc})[ \\t]*(?=\\r?\\n|$)`,
    'gmd',
  );
  let seen = 0;
  let m: RegExpExecArray | null = re.exec(source);
  while (m) {
    if (seen === occurrence) {
      const groupRange = m.indices?.[1];
      if (!groupRange) return null;
      return { start: groupRange[0], end: groupRange[1], wasQuoted: false, open: '', close: '' };
    }
    seen += 1;
    m = re.exec(source);
  }
  return null;
}

/**
 * Locate a sequence-diagram block-condition line (`alt <cond>`,
 * `else <cond>`, `opt <cond>`, `loop <cond>`, `par <cond>`,
 * `critical <cond>`, `break <cond>`) in `source`. Returns the range of
 * the condition token so the caller can rewrite it in place.
 *
 * The mermaid renderer wraps the condition in visible brackets
 * (`[credentials valid]`) inside `.loopText`; the DOM click yields
 * `[credentials valid]`, but the source form is unbracketed. Callers
 * strip the DOM brackets before invoking this locator.
 */
export function findSequenceBlockConditionInSource(
  source: string,
  currentCondition: string,
  occurrence = 0,
): LabelMatch | null {
  const esc = currentCondition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kw = '(?:alt|else|opt|loop|par|par_and|critical|option|and|break|rect)';
  const re = new RegExp(`^([ \\t]*${kw}[ \\t]+)(${esc})[ \\t]*(?=\\r?\\n|$)`, 'gmd');
  let seen = 0;
  let m: RegExpExecArray | null = re.exec(source);
  while (m) {
    if (seen === occurrence) {
      const groupRange = m.indices?.[2];
      if (!groupRange) return null;
      return { start: groupRange[0], end: groupRange[1], wasQuoted: false, open: '', close: '' };
    }
    seen += 1;
    m = re.exec(source);
  }
  return null;
}

// Label selectors that carry visible text across the diagram types inline
// editing supports (flowchart node/edge labels are HTML spans; sequence
// actors/messages/notes/loops are SVG `<text>`).
const FLASHABLE_LABEL_SELECTOR =
  '.nodeLabel, .edgeLabel, text.actor, text.messageText, text.noteText, text.loopText';

/**
 * Flash the rendered label occurrences whose text matches `value` — the "this
 * text changed too" cue used after a WYSIWYG label edit propagates to LINKED
 * occurrences (a renamed sequence participant renders in BOTH its top and
 * bottom actor boxes, so renaming once changes both). Adds the
 * `mermaid-label-flash` class (globals.css) to each match.
 *
 * Flashes only when 2+ occurrences match: a lone label edit has no "related"
 * text to signal, so it stays quiet. Mermaid re-renders the whole SVG on every
 * edit, so the class lands on fresh nodes and the one-shot animation plays
 * without a restart dance. Returns the count flashed.
 */
/**
 * Rendered label occurrences whose text matches `value`, minus `exclude` (and
 * anything nested within an excluded element, either direction). Used by the
 * live-typing preview to find the OTHER occurrences of the token being edited —
 * e.g. the second actor box of the sequence participant under the inline input.
 */
export function collectLinkedLabelTargets(
  container: HTMLElement,
  value: string,
  exclude: readonly Element[] = [],
): Element[] {
  const needle = value.trim();
  if (!needle) return [];
  return Array.from(container.querySelectorAll<Element>(FLASHABLE_LABEL_SELECTOR)).filter(
    (el) =>
      !exclude.some((ex) => ex === el || ex.contains(el) || el.contains(ex)) &&
      (el.textContent ?? '').trim() === needle,
  );
}

/**
 * Pulse one label's glyph paint to the agent accent and back, twice, by
 * toggling INLINE `!important` fill/color. Why inline `!important` and not a CSS
 * class animation: mermaid injects a `<style>` into every rendered SVG whose
 * `.actor` / `tspan` fill rules can out-specify (or `!important`-beat) a
 * class-based `fill` animation, silently cancelling it. An inline `!important`
 * declaration beats those, so the pulse always shows. `fill` colors SVG
 * `<tspan>` glyphs; `color` colors HTML (`.nodeLabel`/`.edgeLabel`) labels —
 * setting both covers either carrier. Honors reduce-motion with one softer
 * pulse. Self-cleans via `removeProperty`; safe if a later re-render detaches
 * the node (the timers just no-op on a detached element).
 */
function pulseGlyphPaint(el: Element): void {
  const style = (el as SVGElement | HTMLElement).style as CSSStyleDeclaration | undefined;
  if (!style) return;
  const on = () => {
    style.setProperty('fill', 'var(--color-agent)', 'important');
    style.setProperty('color', 'var(--color-agent)', 'important');
  };
  const off = () => {
    style.removeProperty('fill');
    style.removeProperty('color');
  };
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (reduce) {
    on();
    setTimeout(off, 600);
    return;
  }
  const beat = 170;
  on();
  setTimeout(off, beat);
  setTimeout(on, beat * 2);
  setTimeout(off, beat * 3);
}

export function flashLinkedLabels(container: HTMLElement, value: string): number {
  const needle = value.trim();
  if (!needle) return 0;
  const matches = Array.from(container.querySelectorAll<Element>(FLASHABLE_LABEL_SELECTOR)).filter(
    (el) => (el.textContent ?? '').trim() === needle,
  );
  if (matches.length < 2) return 0;
  for (const el of matches) {
    // Flash the innermost paint carrier, not the outer element. Mermaid paints
    // the glyph color on an inner `<tspan>` (SVG text) / `<p>` (foreignObject
    // label). The carrier collapses to the element itself when there's no
    // inner tspan/p. The `mermaid-label-flash` class is kept as a semantic
    // marker (and a bonus CSS glow for HTML labels, where `filter` isn't
    // clipped); `pulseGlyphPaint` drives the guaranteed-visible color pulse.
    const carrier = el.querySelector('tspan') ?? el.querySelector('p') ?? el;
    carrier.classList.add('mermaid-label-flash');
    pulseGlyphPaint(carrier);
  }
  return matches.length;
}

export function MermaidView({ chart = '', className, editBinding }: MermaidProps) {
  const reactId = useId();
  const renderId = `mermaid-${reactId.replaceAll(':', '_')}`;
  const [state, setState] = useState<RenderState>({ status: 'idle', svg: '', error: '' });
  // Track the app's color mode so mermaid's palette can flip with the
  // theme provider — reading it once at mount + observing the `<html>`
  // class list keeps SVG contrast aligned even when the user toggles
  // themes with a diagram already on screen. Ties into the `chart`
  // render effect below via the dependency array so a theme flip
  // schedules the same re-render path as a chart edit.
  const [colorMode, setColorMode] = useState<'light' | 'dark'>(() => readDocumentColorMode());
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const doc = document.documentElement;
    const sync = () => {
      const next = readDocumentColorMode();
      setColorMode((prev) => (prev === next ? prev : next));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(doc, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  const host = useJsxComponentHost();
  // An explicit `editBinding` (standalone `.mmd` doc) wins; otherwise editing is
  // gated on the JSX host being editable (codefenced fence).
  const canEdit = editBinding ? editBinding.canEdit : (host?.editor.isEditable ?? false);
  const containerRef = useRef<HTMLDivElement>(null);
  // `useJsxComponentHost()` returns a fresh object literal on every
  // parent render (JsxComponentView constructs `{editor, getPos, ...}`
  // inline), so putting `host` directly in a `useEffect` dep would
  // re-tear-down the edit session on every unrelated re-render of the
  // wrapper. Keep effect deps stable and read the live host through a
  // ref that we sync on each render.
  const hostRef = useRef(host);
  // Sync the ref in a layout effect (runs after render, before paint).
  // Handlers can only fire after paint, so this is early enough to
  // always be current, and it avoids the "Cannot access refs during
  // render" React violation of assigning inside the render body.
  useLayoutEffect(() => {
    hostRef.current = host;
  }, [host]);
  // Same ref treatment for the optional standalone binding: the parent may
  // hand a fresh object each render, so read it live through the ref inside
  // handlers to keep the edit-session effect deps (`[state.status, canEdit]`)
  // stable.
  const editBindingRef = useRef(editBinding);
  useLayoutEffect(() => {
    editBindingRef.current = editBinding;
  }, [editBinding]);
  // Tracks the currently-editing label so we can tear it down cleanly
  // when the SVG re-renders (or component unmounts) mid-edit.
  const editSessionRef = useRef<{ cleanup: () => void } | null>(null);
  // Set to the just-committed label value when a WYSIWYG edit changed the
  // chart; consumed by the post-render effect below to flash the LINKED
  // occurrences (e.g. a renamed participant's other actor box) once the SVG
  // re-renders. Null when no flash is pending.
  const flashValueRef = useRef<string | null>(null);

  useEffect(() => {
    if (!chart.trim()) {
      setState({ status: 'idle', svg: '', error: '' });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'rendering' }));
    void loadPanzoom().catch(() => undefined);
    loadMermaid()
      .then(async (m) => {
        // Re-initialize per render so a color-mode flip picks up the
        // right palette. Config writes are cheap; the render itself is
        // the expensive step.
        configureMermaid(m, colorMode);
        // Mermaid's `render` builds a hidden `<div id={renderId}>`
        // off-screen, computes layout, and returns the inert SVG
        // string. The DOM scratchpad is cleaned up by Mermaid itself.
        const result = await m.render(renderId, chart);
        if (!cancelled) {
          setState({ status: 'ready', svg: result.svg, error: '' });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setState({ status: 'error', svg: '', error: msg });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId, colorMode]);

  // After a WYSIWYG edit re-renders the SVG, flash the linked occurrences of
  // the just-committed value (armed by `commitLabelChangeGeneric`). Keyed on
  // `state.svg`, NOT `state.status`: a warm re-render can batch the
  // `rendering`→`ready` transition so `status` collapses `ready`→`ready` and a
  // `[state.status]` effect never re-runs. The svg string changes on every
  // successful render, so keying on it fires reliably once the new SVG is in
  // the DOM. Consume-and-clear so an unrelated re-render (theme flip, remote
  // edit) never replays a stale flash.
  useEffect(() => {
    const value = flashValueRef.current;
    if (value === null) return;
    // A successful render always produces a non-empty svg; skip the idle/error
    // renders (svg === '') where there are no nodes to flash.
    if (!state.svg) return;
    flashValueRef.current = null;
    const container = containerRef.current;
    if (container) flashLinkedLabels(container, value);
  }, [state.svg]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    if (!canEdit) return;
    const container = containerRef.current;
    if (!container) return;

    // Discoverability hint — set cursor to `text` on every rendered node
    // label so the "you can type here" affordance is obvious before the
    // user commits to a double-click. Applied post-mermaid-render so it
    // survives the SVG rebuild.
    for (const label of container.querySelectorAll<HTMLElement>('.nodeLabel, .edgeLabel')) {
      label.style.cursor = 'text';
    }
    // The full pointer-events + cursor treatment for the SVG-text
    // surfaces (`text.actor`, `text.messageText`, `text.noteText`,
    // `text.loopText`, `rect.note`) is applied inside the click-
    // handler effect below so the same helper owns both the widened
    // hit-testing and the delegated click routing.

    // Read the current chart source live at call time. Standalone binding wins;
    // otherwise read the JSX-host `jsxComponent` node's `chart` prop.
    function readChartSource(): string | null {
      const binding = editBindingRef.current;
      if (binding) return binding.getChart();
      const h = hostRef.current;
      if (!h) return null;
      const pos = h.getPos();
      if (typeof pos !== 'number') return null;
      const node = h.editor.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'jsxComponent') return null;
      return ((node.attrs.props as Record<string, unknown>)?.chart as string) ?? '';
    }

    // Write the new chart source back. Standalone binding wins; otherwise
    // dispatch one `setNodeMarkup` on the JSX-host `jsxComponent` node.
    function commitChartSource(newChart: string): void {
      const binding = editBindingRef.current;
      if (binding) {
        binding.commitChart(newChart);
        return;
      }
      const h = hostRef.current;
      if (!h) return;
      const pos = h.getPos();
      if (typeof pos !== 'number') return;
      const node = h.editor.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'jsxComponent') return;
      const currentProps = (node.attrs.props as Record<string, unknown>) ?? {};
      // `setNodeMarkup` throws `RangeError` when `pos` has been
      // invalidated by a concurrent CRDT update between `getPos()` and
      // dispatch. That's a benign miss (the user's next mount resyncs
      // from the new canonical state) so we drop it. Any other
      // exception is a real bug and must surface.
      try {
        h.editor.view.dispatch(
          h.editor.state.tr.setNodeMarkup(pos, null, {
            ...node.attrs,
            props: { ...currentProps, chart: newChart },
            sourceDirty: true,
          }),
        );
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
      }
    }

    function commitLabelChangeGeneric(target: EditTarget, newLabel: string): void {
      const chartNow = readChartSource();
      if (chartNow === null) return;
      // Prefer applyRewrite (participant paths); otherwise fall back
      // to locate + spliceNewLabel.
      let newChart: string | null = null;
      if (target.applyRewrite) {
        newChart = target.applyRewrite(chartNow, newLabel);
      } else if (target.locate) {
        const match = target.locate(chartNow);
        if (match) newChart = spliceNewLabel(chartNow, match, newLabel);
      }
      if (newChart === null) return;
      // Arm the linked-occurrence flash only when the edit actually changed the
      // source — so the post-render effect fires once on the resulting re-render
      // (a no-op edit produces no re-render, which would otherwise leave a stale
      // value to flash on the next unrelated render).
      if (newChart !== chartNow) flashValueRef.current = newLabel.trim();
      commitChartSource(newChart);
    }

    interface EditTarget {
      labelSpan: HTMLElement;
      // The SVG element (rect/polygon/path...) whose stroke we widen to
      // signal "this thing is being edited". Null when the target has
      // no single shape to tint (edge labels, sequence messages,
      // sequence participants).
      outlineShape: SVGElement | null;
      // Optional visual anchor used to POSITION the input. Defaults to
      // `labelSpan`. Provide when the label sits inside a bigger
      // container that better represents the visual box the user
      // clicked — e.g. sequence-diagram actors, where the `<text>`
      // element's tight glyph bbox doesn't match the actor `<rect>`
      // box the label appears inside, causing the text to visibly
      // shift when replaced by an HTML input whose text-align: center
      // is over a narrower rect.
      positionAnchor?: Element;
      // Preferred: `applyRewrite` returns the new chart source directly.
      // Used for surfaces where the edit isn't a pure span replacement
      // — e.g. participant renames may need to ADD an `as "..."` alias
      // instead of overwriting the id. Called against the CURRENT chart
      // source so a peer edit between click and commit doesn't desync.
      applyRewrite?: (chartNow: string, newLabel: string) => string | null;
      // Fallback: locate a span, then `spliceNewLabel` replaces it. Used
      // for node/edge/message labels where the edit is a pure span
      // replacement. Ignored when `applyRewrite` is set.
      locate?: (chartNow: string) => LabelMatch | null;
      // Optional override for the string the input opens with (and the
      // no-op comparison at commit). Defaults to the DOM label text.
      // Provide when the DOM renders decoration around the source token
      // — e.g. mermaid wraps `alt <cond>` conditions in visible brackets
      // `[cond]`, but the source form is unbracketed, so the input
      // should open with the source form and the rewrite should replace
      // the source range with what the user typed.
      sourceLabel?: string;
    }

    function tryEnterEditWithTarget(target: EditTarget, event: MouseEvent): boolean {
      const { labelSpan, outlineShape } = target;
      const currentChart = readChartSource();
      if (currentChart === null) return false;
      const currentLabel = target.sourceLabel ?? (labelSpan.textContent ?? '').trim();
      if (!currentLabel) return false;
      const rewriteHit = target.applyRewrite?.(currentChart, currentLabel);
      const locateHit = target.locate?.(currentChart);
      // Consider the edit "possible" if either path produces a match.
      // For `applyRewrite`, rewriting `currentLabel` → `currentLabel`
      // is a no-op transform that still returns non-null on success.
      if (!locateHit && rewriteHit == null) return false;

      event.preventDefault();
      event.stopPropagation();

      // Portal-based edit surface. The `.nodeLabel` lives inside PM's
      // editor tree (`.ProseMirror` -> JsxComponentView wrapper -> SVG
      // -> foreignObject -> span -> p). Any contenteditable / input
      // mounted inside that tree is watched by PM's MutationObserver
      // AND its beforeinput/input handlers, no matter how many events
      // we stop -- PM reacts to any DOM change it did not authorize by
      // re-syncing the tree to its own model, which manifests as page
      // jumps + focus shifts on the first keystroke.
      //
      // The fix that actually holds: mount the input as a sibling of
      // <body> (outside PM entirely), position it absolutely to cover
      // the label rectangle, and hide the underlying label while the
      // overlay is present. PM sees no DOM inside its tree change
      // during typing; on commit we dispatch one `setNodeMarkup` and
      // mermaid re-renders the SVG normally.
      const labelP = (labelSpan.querySelector('p') ?? labelSpan) as HTMLElement;
      const labelStyles = window.getComputedStyle(labelP);
      // Mermaid often paints the visible glyph color on an inner
      // `<tspan>` while the outer `<text>` carries a background-
      // matching fill so theme overrides cascade cleanly. Resolve the
      // innermost paint carrier once so both the input color and the
      // font metrics below read from the same source.
      const paintCarrier: Element =
        labelP instanceof SVGGraphicsElement ? (labelP.querySelector('tspan') ?? labelP) : labelP;
      const paintStyles = window.getComputedStyle(paintCarrier);
      // SVG `<text>` colors its glyphs via `fill`, not CSS `color`.
      // Copy that paint into the HTML input's `color`; without this
      // the input inherits the browser's dark-mode default (near-
      // white) and reads as invisible against the actor's light box.
      const svgTextColor = ((): string | null => {
        if (!(labelP instanceof SVGGraphicsElement)) return null;
        const fill = paintStyles.fill;
        return fill && fill !== 'none' ? fill : null;
      })();
      const inputColor = svgTextColor ?? labelStyles.color;
      const nodeShape = outlineShape;
      const nodeShapeStrokeBefore: string | null = nodeShape?.getAttribute('stroke') ?? null;
      const nodeShapeStrokeWidthBefore: string | null =
        nodeShape?.getAttribute('stroke-width') ?? null;

      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentLabel;
      input.setAttribute('data-mermaid-editing', 'true');
      input.setAttribute('spellcheck', 'true');
      // The overlay lives at <body> to sit outside PM's DOM (so PM can't
      // see the typing) but visually the goal is "the label is now an
      // input" — no dark box, no heavy border, no color shift. We copy
      // the label's own typography exactly, leave the background fully
      // transparent so mermaid's own node fill shows through, and
      // suppress every hint of an input-frame the browser adds by
      // default (border, outline, shadow, autofill background). The
      // caret is the only editing signal on the label itself; the node
      // outline (widened via `nodeShape` below) confirms which shape is
      // being edited without slapping a modal chrome over the diagram.
      // SVG `<text>` elements don't reliably populate the `font`
      // shorthand in `getComputedStyle` — Chrome fills it, WebKit
      // often doesn't, and either can drop the SVG-declared font-family
      // in favor of the UA default. Read the font primitives directly
      // from the same paint carrier resolved above so the overlay
      // input renders with the SVG-declared face + size.
      Object.assign(input.style, {
        position: 'fixed',
        margin: '0',
        padding: '0',
        fontFamily: paintStyles.fontFamily,
        fontSize: paintStyles.fontSize,
        fontWeight: paintStyles.fontWeight,
        fontStyle: paintStyles.fontStyle,
        fontFeatureSettings: paintStyles.fontFeatureSettings,
        letterSpacing: paintStyles.letterSpacing,
        color: inputColor,
        textAlign: 'center',
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
        boxSizing: 'border-box',
        // Chrome respects the page `color-scheme: dark` on inputs by
        // slapping a dark fill onto them regardless of `background` —
        // force the light rendering path and clear every fill vector
        // (background, backdrop-filter, appearance chrome) explicitly.
        colorScheme: 'light',
        appearance: 'none',
        WebkitAppearance: 'none',
        caretColor: inputColor,
        zIndex: '2147483647',
      });
      // `background: transparent` in a plain Object.assign gets ignored
      // by Chrome's forced-color-scheme rendering path. `setProperty`
      // with `!important` beats the UA stylesheet, which is what we
      // need for the input to actually disappear behind the label.
      input.style.setProperty('background', 'transparent', 'important');
      input.style.setProperty('background-color', 'transparent', 'important');
      // Widen and tint the SVG node's own stroke to signal "this node
      // is being edited" — this is the visual affordance instead of a
      // heavy input frame. Restored on cleanup below.
      if (nodeShape) {
        nodeShape.setAttribute('stroke', 'var(--ring, #3b82f6)');
        nodeShape.setAttribute('stroke-width', '2');
      }
      // Hide the underlying SVG label while the overlay is present so
      // there's no double-render / peek-through.
      const prevLabelVisibility = labelP.style.visibility;
      labelP.style.visibility = 'hidden';

      // Live preview: mirror each keystroke into the OTHER rendered occurrences
      // of the same token (e.g. a sequence participant's second actor box) so
      // the whole diagram tracks the edit before commit. DOM-only — `Y.Text` is
      // untouched until commit, so a concurrent editor sees nothing mid-type,
      // and a remote edit that re-renders tears this down via the edit-session
      // cleanup. Each target's `innerHTML` is captured so cleanup can restore it
      // (Escape reverts; commit re-renders over it — mermaid re-lays-out box
      // geometry, which stays fixed during the preview).
      const visibleLabel = (labelSpan.textContent ?? '').trim();
      const linkedPreview: Array<{ el: Element; html: string }> = containerRef.current
        ? collectLinkedLabelTargets(containerRef.current, visibleLabel, [labelSpan, labelP]).map(
            (el) => ({ el, html: el.innerHTML }),
          )
        : [];
      function syncLinkedPreview(): void {
        const next = input.value;
        for (const { el } of linkedPreview) {
          // Write into the innermost paint carrier so the occurrence keeps its
          // glyph fill. Mermaid paints the visible color on an inner `<tspan>`
          // (SVG text) or `<p>` (foreignObject label) while the outer element
          // carries only a background-matching fill (see the input-color note
          // above). Replacing the whole element's `textContent` drops that
          // carrier, so the preview text falls back to the near-invisible
          // background fill and reads as a faded "ghost". Targeting the carrier
          // keeps it the same weight/color as the committed label.
          const carrier = el.querySelector('tspan') ?? el.querySelector('p') ?? el;
          carrier.textContent = next;
        }
      }

      document.body.appendChild(input);
      // Position the input *after* it's in the DOM so we can use its
      // own measured metrics — the browser hasn't laid it out until
      // then, and matching the label's rect exactly is what makes the
      // swap feel like the label just became typeable.
      // Use the caller-supplied positioning anchor if any (better for
      // labels whose visible box is BIGGER than the text glyph bbox —
      // sequence actors, edge labels wrapped in a bg rect); otherwise
      // fall back to the label element itself.
      const anchor: Element = target.positionAnchor ?? labelP;
      // Minimum comfortable typing space. Short bare-id actors like
      // `User` render into a rect that's ~14px wide — enough for the
      // static glyphs but not enough to type past the current label
      // without immediate clipping. `ch` is Chrome-accurate for
      // monospace glyphs; for the proportional fonts mermaid uses it
      // rounds up conservatively (roughly one em of headroom either
      // side of the current text).
      const inputMinCh = Math.max(currentLabel.length + 4, 8);
      // Declared font size on the SVG (or the foreignObject HTML label)
      // lives in the SVG user coordinate space. Mermaid's SVG uses a
      // `viewBox` so the on-screen glyph size is the declared size
      // multiplied by the viewBox-to-screen scale — the input mounts
      // outside the SVG at absolute screen coordinates and would
      // otherwise render at the raw declared size (~16 px screen)
      // while the underlying label renders at ~9-10 px screen, blowing
      // the size mismatch that reads as "not WYSIWYG". Capture the
      // declared size once and compute the effective scale per
      // reposition so the input tracks the label even after resizes
      // or zoom changes.
      const declaredFontSizePx = parseFloat(paintStyles.fontSize) || 16;
      function computeSvgRenderScale(): number {
        // For SVG shapes we own directly (rect.actor, rect.note, node
        // outlines) the anchor's own bbox-vs-screen ratio is the tightest
        // measurement — no assumption about `preserveAspectRatio`.
        if (anchor instanceof SVGGraphicsElement) {
          try {
            const bbox = anchor.getBBox();
            if (bbox.height > 0) {
              return anchor.getBoundingClientRect().height / bbox.height;
            }
          } catch {
            // getBBox throws on detached nodes / mid-transition SVGs.
          }
        }
        // Flowchart node labels live inside a `<foreignObject>` — the
        // HTML `<p>` isn't an SVGGraphicsElement, so anchor to the
        // owning SVG's overall viewBox scale instead. Mermaid emits
        // SVGs with `preserveAspectRatio="xMinYMin meet"` (default),
        // so the content scale is uniform and equals
        // `min(rectWidth / vbWidth, rectHeight / vbHeight)`. The
        // rendered box can be wider or taller than the viewBox needs
        // (letterboxing / pillarboxing outside the diagram area), so
        // picking the smaller axis matches the actual glyph scale.
        const svg =
          (labelP instanceof SVGElement ? labelP.ownerSVGElement : null) ??
          (labelP instanceof Element ? labelP.closest('svg') : null);
        if (svg instanceof SVGSVGElement) {
          const vb = svg.viewBox.baseVal;
          if (vb.width > 0 && vb.height > 0) {
            const rect = svg.getBoundingClientRect();
            return Math.min(rect.width / vb.width, rect.height / vb.height);
          }
        }
        return 1;
      }
      function positionInput(): void {
        const r = anchor.getBoundingClientRect();
        // Pin the input's CENTER to the anchor's center rather than
        // its left edge. Without this, the min-width widens the input
        // past the anchor's natural width and the (text-align: center)
        // text ends up offset from where the SVG glyphs were sitting —
        // which reads as the label "jumping" the moment you click it.
        // Centering keeps the glyphs pinned regardless of how wide we
        // grow the typing surface.
        input.style.top = `${r.top}px`;
        input.style.width = `${r.width}px`;
        input.style.minWidth = `${inputMinCh}ch`;
        input.style.height = `${r.height}px`;
        input.style.lineHeight = `${r.height}px`;
        const scale = computeSvgRenderScale();
        input.style.fontSize = `${declaredFontSizePx * scale}px`;
        // Read the effective width after `min-width` clamps so we can
        // offset the input left to keep its horizontal center matched
        // to the anchor's. `getBoundingClientRect` after the width
        // writes above gives us the actually-rendered width, which is
        // what `text-align: center` will use to place the glyphs.
        input.style.left = `${r.left}px`;
        const effective = input.getBoundingClientRect();
        const anchorCenter = r.left + r.width / 2;
        const inputLeft = anchorCenter - effective.width / 2;
        input.style.left = `${inputLeft}px`;
      }
      positionInput();
      // Focus + select-all after the next paint. Sync focus() sometimes
      // loses to whatever else is settling from the click that started
      // the edit; rAF hands us the frame after PM/JsxComponentView have
      // finished reacting.
      const focusRafHandle = requestAnimationFrame(() => {
        input.focus();
        input.select();
      });

      // Keep the overlay pinned if the page scrolls or the label moves.
      window.addEventListener('scroll', positionInput, true);
      window.addEventListener('resize', positionInput);
      input.addEventListener('input', syncLinkedPreview);

      let done = false;
      function cleanup(): void {
        cancelAnimationFrame(focusRafHandle);
        window.removeEventListener('scroll', positionInput, true);
        window.removeEventListener('resize', positionInput);
        input.removeEventListener('keydown', onKeyDown);
        input.removeEventListener('blur', onBlur);
        input.removeEventListener('input', syncLinkedPreview);
        input.remove();
        // Restore the live-previewed occurrences to their original markup. On
        // Escape this reverts them; on commit the ensuing re-render replaces
        // them with the new value (and PR-1's flash fires on the linked ones).
        for (const { el, html } of linkedPreview) el.innerHTML = html;
        labelP.style.visibility = prevLabelVisibility;
        if (nodeShape) {
          if (nodeShapeStrokeBefore === null) {
            nodeShape.removeAttribute('stroke');
          } else {
            nodeShape.setAttribute('stroke', nodeShapeStrokeBefore);
          }
          if (nodeShapeStrokeWidthBefore === null) {
            nodeShape.removeAttribute('stroke-width');
          } else {
            nodeShape.setAttribute('stroke-width', nodeShapeStrokeWidthBefore);
          }
        }
        editSessionRef.current = null;
      }
      function commit(): void {
        if (done) return;
        done = true;
        const next = input.value.trim();
        cleanup();
        if (!next || next === currentLabel) return;
        commitLabelChangeGeneric(target, next);
      }
      function discard(): void {
        if (done) return;
        done = true;
        cleanup();
      }
      function onKeyDown(ev: KeyboardEvent): void {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          discard();
          return;
        }
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          commit();
          return;
        }
        // Any other key: stop propagation so PM's editor-level
        // handlers (attached higher up the tree) don't see a keystroke
        // that "escaped" our overlay.
        ev.stopPropagation();
      }
      function onBlur(): void {
        commit();
      }
      input.addEventListener('keydown', onKeyDown);
      input.addEventListener('blur', onBlur);
      // Force-discard on cleanup path (SVG re-render / unmount mid-edit).
      editSessionRef.current = {
        cleanup: () => {
          if (!done) discard();
        },
      };
      return true;
    }

    // Single-click enters edit — matches how the rest of the WYSIWYG
    // behaves (click text, start typing). Clicks outside a label still
    // fall through to JsxComponentView's `handleBodyClick` for
    // NodeSelection, so both affordances survive.
    function onLabelClick(event: MouseEvent): void {
      if (editSessionRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      const nodeLabelSpan = target.closest<HTMLElement>('.nodeLabel');
      if (nodeLabelSpan) {
        const nodeGroup = target.closest<HTMLElement>('.node[id]');
        if (!nodeGroup) return;
        const nodeIdRaw = extractSourceNodeId(nodeGroup.id);
        if (!nodeIdRaw) return;
        const nodeId: string = nodeIdRaw;
        const currentLabel = (nodeLabelSpan.textContent ?? '').trim();
        if (!currentLabel) return;
        // Bare-id nodes (`Shopper --> Storefront` — no `Shopper[…]`
        // shape) render the id itself as the visible label. When the
        // shape-splice locator misses AND the DOM label equals the node
        // id, fall through to appending `[NewLabel]` after the first
        // bare id occurrence. Preserving the id keeps every
        // `Shopper -->` arrow elsewhere in the chart resolving. Both
        // `locate` and `applyRewrite` route through this resolver so
        // the editability probe and the commit path can never disagree.
        function resolveFlowchartNodeHit(chartNow: string): {
          match: LabelMatch;
          splice: (source: string, m: LabelMatch, next: string) => string;
        } | null {
          const shapeHit = findLabelInSource(chartNow, nodeId, currentLabel);
          if (shapeHit) return { match: shapeHit, splice: spliceNewLabel };
          if (currentLabel !== nodeId) return null;
          const bareHit = findFlowchartBareIdInSource(chartNow, nodeId);
          if (!bareHit) return null;
          return { match: bareHit, splice: spliceInsertBareIdLabel };
        }
        tryEnterEditWithTarget(
          {
            labelSpan: nodeLabelSpan,
            outlineShape: nodeGroup.querySelector<SVGElement>(
              'rect, polygon, path, circle, ellipse',
            ),
            locate: (chartNow) => resolveFlowchartNodeHit(chartNow)?.match ?? null,
            applyRewrite: (chartNow, newLabel) => {
              const hit = resolveFlowchartNodeHit(chartNow);
              return hit ? hit.splice(chartNow, hit.match, newLabel) : null;
            },
          },
          event,
        );
        return;
      }

      const actorText = target.closest<SVGTextElement>('text.actor');
      if (actorText) {
        // Sequence-diagram participant. The DOM class `.actor.actor-box`
        // sits on both the top and bottom labels (mermaid duplicates
        // them at each end of the timeline), so the source occurrence
        // count is `DOM order / 2`.
        const currentDisplay = (actorText.textContent ?? '').trim();
        if (!currentDisplay) return;
        const svg = actorText.ownerSVGElement;
        let occurrence = 0;
        if (svg) {
          const all = Array.from(svg.querySelectorAll<SVGTextElement>('text.actor'));
          let seen = 0;
          for (const el of all) {
            if (el === actorText) {
              occurrence = Math.floor(seen / 2);
              break;
            }
            if ((el.textContent ?? '').trim() === currentDisplay) seen += 1;
          }
        }
        // Positioning anchor: the actor's own `<rect>` sibling (the
        // visible actor box). Not every actor kind renders one — the
        // `actor` keyword produces the stick-figure `actor-man` group
        // whose bounding rect extends from head to the label below.
        // Using the group's rect there mounts the input at the group
        // top with lineHeight = group height, so the input's centered
        // text lands ~20 px above the SVG label. Leave `positionAnchor`
        // undefined in that case and fall back to the text glyph's own
        // bbox, which sits exactly where the user clicked.
        const actorGroup = actorText.parentElement;
        const actorRectSibling = actorGroup?.querySelector<SVGGraphicsElement>('rect.actor');
        tryEnterEditWithTarget(
          {
            labelSpan: actorText as unknown as HTMLElement,
            outlineShape: null,
            positionAnchor: actorRectSibling ?? undefined,
            applyRewrite: (chartNow, newLabel) =>
              rewriteSequenceParticipant(chartNow, currentDisplay, newLabel, occurrence),
          },
          event,
        );
        return;
      }

      const messageText = target.closest<SVGTextElement>('text.messageText');
      if (messageText) {
        // Sequence-diagram message body. The DOM `<text.messageText>`
        // element doesn't carry actor pair info, so the source match
        // is by text alone. Duplicate identical messages tie-break on
        // `occurrence` (DOM order of same-text messages before this one).
        const currentLabel = (messageText.textContent ?? '').trim();
        if (!currentLabel) return;
        const svg = messageText.ownerSVGElement;
        let occurrence = 0;
        if (svg) {
          const all = Array.from(svg.querySelectorAll<SVGTextElement>('text.messageText'));
          for (const el of all) {
            if (el === messageText) break;
            if ((el.textContent ?? '').trim() === currentLabel) occurrence += 1;
          }
        }
        tryEnterEditWithTarget(
          {
            labelSpan: messageText as unknown as HTMLElement,
            outlineShape: null,
            locate: (chartNow) => findSequenceMessageInSource(chartNow, currentLabel, occurrence),
          },
          event,
        );
        return;
      }

      const edgeLabelSpan = target.closest<HTMLElement>('.edgeLabel');
      if (edgeLabelSpan) {
        // Mermaid wraps the edge label in `<g class="label" data-id="L_<from>_<to>_<idx>">`
        // — that's the only place the from/to/index is emitted. Walk up
        // to the nearest `[data-id^="L_"]` ancestor for the identifier.
        const labelGroup = edgeLabelSpan.closest<HTMLElement>('g[data-id^="L_"]');
        const dataId = labelGroup?.getAttribute('data-id');
        if (!dataId) return;
        const info = extractEdgeInfo(dataId);
        if (!info) return;
        const currentLabel = (edgeLabelSpan.textContent ?? '').trim();
        if (!currentLabel) return;
        tryEnterEditWithTarget(
          {
            labelSpan: edgeLabelSpan,
            // Edge stroke is on a `<path>` outside the label group — not
            // reliably tied to this label's rect — so we skip the
            // stroke-widen affordance for edges. The input's caret and
            // the surrounding text still make edit mode obvious.
            outlineShape: null,
            locate: (chartNow) =>
              findEdgeLabelInSource(chartNow, info.from, info.to, info.index, currentLabel),
          },
          event,
        );
        return;
      }

      // Sequence-diagram Note over|left of|right of. Same locate-then-
      // splice shape as messageText. The DOM only exposes the body, so
      // duplicate bodies tie-break via `occurrence` (DOM order among
      // same-body notes before this one). Clicks in the note box's
      // padding (between text glyphs, or on the left/right of the
      // label inside the yellow rect) land on `rect.note` — walk to
      // the sibling `text.noteText` so the padding is treated as part
      // of the note surface.
      const noteRectHit = target.closest<SVGRectElement>('rect.note');
      const noteText =
        target.closest<SVGTextElement>('text.noteText') ??
        noteRectHit?.parentElement?.querySelector<SVGTextElement>('text.noteText') ??
        null;
      if (noteText) {
        const currentNote = (noteText.textContent ?? '').trim();
        if (!currentNote) return;
        const svg = noteText.ownerSVGElement;
        let occurrence = 0;
        if (svg) {
          const all = Array.from(svg.querySelectorAll<SVGTextElement>('text.noteText'));
          for (const el of all) {
            if (el === noteText) break;
            if ((el.textContent ?? '').trim() === currentNote) occurrence += 1;
          }
        }
        // Position anchor: the yellow note `<rect>` sibling — always
        // wider than the glyph bbox so the input covers the visible box
        // rather than tightly around the text.
        const noteGroup = noteText.parentElement;
        const noteRect =
          noteGroup?.querySelector<SVGGraphicsElement>('rect.note') ??
          (noteText.previousElementSibling instanceof SVGGraphicsElement
            ? noteText.previousElementSibling
            : null);
        tryEnterEditWithTarget(
          {
            labelSpan: noteText as unknown as HTMLElement,
            outlineShape: null,
            positionAnchor: noteRect ?? undefined,
            locate: (chartNow) => findSequenceNoteInSource(chartNow, currentNote, occurrence),
          },
          event,
        );
        return;
      }

      // Sequence-diagram alt/else/opt/loop/par/critical block header.
      // The DOM `text.loopText` renders the condition wrapped in visible
      // brackets (`[credentials valid]`); the source form is
      // unbracketed. Strip brackets before locating.
      const loopText = target.closest<SVGTextElement>('text.loopText');
      if (loopText) {
        const displayed = (loopText.textContent ?? '').trim();
        // Strip surrounding brackets (`[…]`) that mermaid renders around
        // the condition. Fall through untouched if the author didn't use
        // brackets (rare / non-standard mermaid).
        const currentCondition =
          displayed.startsWith('[') && displayed.endsWith(']')
            ? displayed.slice(1, -1).trim()
            : displayed;
        if (!currentCondition) return;
        const svg = loopText.ownerSVGElement;
        let occurrence = 0;
        if (svg) {
          const all = Array.from(svg.querySelectorAll<SVGTextElement>('text.loopText'));
          for (const el of all) {
            if (el === loopText) break;
            const other = (el.textContent ?? '').trim();
            const otherCondition =
              other.startsWith('[') && other.endsWith(']') ? other.slice(1, -1).trim() : other;
            if (otherCondition === currentCondition) occurrence += 1;
          }
        }
        tryEnterEditWithTarget(
          {
            labelSpan: loopText as unknown as HTMLElement,
            outlineShape: null,
            sourceLabel: currentCondition,
            locate: (chartNow) =>
              findSequenceBlockConditionInSource(chartNow, currentCondition, occurrence),
          },
          event,
        );
      }
    }

    // Click handling runs in capture-phase so we intercept BEFORE
    // JsxComponentView's `handleBodyClick` (attached as a React onClick
    // that delegates through the React root, bubble-phase). This does
    // three things at once for a click inside `.nodeLabel`:
    //   1. Stop propagation so the wrapper never `setNodeSelection`s and
    //      re-renders the JsxComponentView subtree (which would tear
    //      down our label DOM between the first and second click).
    //   2. Feed our own two-click-within-threshold detection.
    //   3. On the second click, enter edit mode.
    // Mousedown is captured too for the same stopPropagation reason —
    // PM's own selection handling runs at mousedown time. Clicks outside
    // `.nodeLabel` (edges, blank canvas) still reach the wrapper and
    // still NodeSelect the block, so both affordances survive.
    function onLabelMouseDown(event: MouseEvent): void {
      const t = event.target;
      if (!(t instanceof Element)) return;
      if (
        !t.closest(
          '.nodeLabel, .edgeLabel, text.messageText, text.actor, text.noteText, text.loopText, rect.note',
        )
      )
        return;
      event.stopPropagation();
    }
    function onLabelClickCapture(event: MouseEvent): void {
      const t = event.target;
      if (!(t instanceof Element)) return;
      if (
        !t.closest(
          '.nodeLabel, .edgeLabel, text.messageText, text.actor, text.noteText, text.loopText, rect.note',
        )
      )
        return;
      event.stopPropagation();
      onLabelClick(event);
    }

    // SVG `<text>` defaults to `pointer-events: painted`, which sends
    // clicks BETWEEN glyphs (the ~2 px gaps that are unpainted) through
    // to whatever is behind. For flowchart node labels + edge labels
    // that's fine because the outline shape catches those clicks and
    // the closest-selector walk handles them. For sequence-diagram
    // actors, messages, notes, and loop-condition labels there IS no
    // downstream catcher inside the group — the click would fall
    // through to the SVG background. Force `pointer-events: all` on
    // every editable text surface + the note rect so the whole visible
    // bbox is clickable. The cursor hint reinforces that the text is
    // editable on hover.
    for (const el of container.querySelectorAll<SVGElement>(
      'text.actor, text.messageText, text.noteText, text.loopText, rect.note',
    )) {
      el.style.pointerEvents = 'all';
      el.style.cursor = 'text';
    }
    container.addEventListener('mousedown', onLabelMouseDown, { capture: true });
    container.addEventListener('click', onLabelClickCapture, { capture: true });
    return () => {
      container.removeEventListener('mousedown', onLabelMouseDown, { capture: true });
      container.removeEventListener('click', onLabelClickCapture, { capture: true });
      editSessionRef.current?.cleanup();
      editSessionRef.current = null;
    };
    // host intentionally NOT in deps — it's a fresh object every render
    // (see hostRef comment above). Handlers use hostRef.current.
  }, [state.status, canEdit]);

  if (!chart.trim()) {
    return (
      <div className="mermaid mermaid-placeholder" data-component-type="mermaid">
        <span className="mermaid-empty"> </span>
      </div>
    );
  }

  if (state.status === 'error') {
    // Error banner sits ABOVE the source — readers' eyes land on the
    // diagnosis first, then the offending code. Putting the message below
    // (the original order) read as a stray paragraph because the unstyled
    // text blended into body content. The destructive-toned chrome here
    // mirrors `PropertyPanel`'s malformed-FM banner so the same visual
    // language signals "agent-visible error" across surfaces.
    return (
      <div className="mermaid mermaid-error" data-component-type="mermaid" title={state.error}>
        <div
          role="alert"
          className="mermaid-error-message mb-2 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
        >
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0">
            <div className="font-medium">
              <Trans>Mermaid diagram failed to render.</Trans>
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] opacity-90">
              {state.error}
            </pre>
          </div>
        </div>
        {/* The chart source shows WHAT the author wrote so they can locate
            the offending line/column the parser message refers to. */}
        <pre className="mermaid-error-source">{chart}</pre>
      </div>
    );
  }

  if (state.status === 'ready') {
    return (
      <div
        ref={containerRef}
        className={cn(
          'mermaid mermaid-ready flex h-full min-h-64 w-full overflow-hidden rounded-md border border-border/60 bg-background',
          className,
        )}
        data-component-type="mermaid"
      >
        <MermaidInteractiveView svg={state.svg} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      // Class follows the actual render state. Before the async
      // `mermaid.render()` resolves the chart is non-empty but `state.svg`
      // is `''` and `state.status` is `idle` or `rendering` — emitting
      // `mermaid-ready` in that window mislabels the DOM for any inspector
      // (devtools, theming hooks, screen-reader CSS). `mermaid-${status}`
      // narrows the rendered class to one of `idle`/`rendering`/`ready`.
      className={`mermaid mermaid-${state.status}`}
      data-component-type="mermaid"
    />
  );
}

function MermaidInteractiveView({ svg }: { svg: string }) {
  const { t } = useLingui();
  const svgHostRef = useRef<HTMLDivElement | null>(null);
  const panzoomRef = useRef<PanzoomObject | null>(null);
  const labels = {
    zoomIn: t`Zoom in`,
    zoomOut: t`Zoom out`,
    reset: t`Reset view`,
    panUp: t`Pan up`,
    panDown: t`Pan down`,
    panLeft: t`Pan left`,
    panRight: t`Pan right`,
    toolbar: t`Mermaid diagram controls`,
  } as const;

  useEffect(() => {
    if (!svg.trim()) return;
    const svgElement = svgHostRef.current?.querySelector<SVGElement>('svg');
    if (svgElement?.namespaceURI !== 'http://www.w3.org/2000/svg') return;

    let disposed = false;
    let panzoom: PanzoomObject | null = null;

    loadPanzoom()
      .then((Panzoom) => {
        if (disposed) return;

        panzoom = Panzoom(svgElement, {
          canvas: true,
          cursor: 'default',
          maxScale: MERMAID_ZOOM_MAX,
          minScale: MERMAID_ZOOM_MIN,
          noBind: true,
          step: MERMAID_ZOOM_STEP,
          touchAction: 'auto',
        });
        panzoomRef.current = panzoom;
      })
      .catch((err) => {
        console.warn('[Mermaid] panzoom setup failed:', err);
        if (panzoomRef.current === panzoom) {
          panzoomRef.current = null;
        }
      });

    return () => {
      disposed = true;
      if (panzoomRef.current === panzoom) {
        panzoomRef.current = null;
      }
      panzoom?.destroy();
    };
  }, [svg]);

  const panBy = (x: number, y: number) => {
    panzoomRef.current?.pan(x, y, { relative: true });
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-muted/20"
      contentEditable={false}
    >
      <div
        ref={svgHostRef}
        className="ok-mermaid-svg flex min-h-0 flex-1 items-center justify-center [&>svg]:size-full [&>svg]:select-none"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid.render with securityLevel:'strict' returns a sanitized SVG string with no script execution; this is the documented integration path.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div
        className="absolute right-3 bottom-3 grid grid-cols-3 gap-1"
        data-testid="mermaid-actions"
        role="toolbar"
        aria-label={labels.toolbar}
      >
        <span aria-hidden="true" />
        <Button
          {...buttonProps}
          title={labels.panUp}
          aria-label={labels.panUp}
          onClick={() => panBy(0, -MERMAID_PAN_STEP)}
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </Button>
        <Button
          {...buttonProps}
          title={labels.zoomIn}
          aria-label={labels.zoomIn}
          onClick={() => panzoomRef.current?.zoomIn()}
        >
          <ZoomIn className="size-4" aria-hidden="true" />
        </Button>
        <Button
          {...buttonProps}
          title={labels.panLeft}
          aria-label={labels.panLeft}
          onClick={() => panBy(-MERMAID_PAN_STEP, 0)}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Button>
        <Button
          {...buttonProps}
          title={labels.reset}
          aria-label={labels.reset}
          onClick={() => panzoomRef.current?.reset()}
        >
          <RefreshCcw className="size-4" aria-hidden="true" />
        </Button>
        <Button
          {...buttonProps}
          title={labels.panRight}
          aria-label={labels.panRight}
          onClick={() => panBy(MERMAID_PAN_STEP, 0)}
        >
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
        <span aria-hidden="true" />
        <Button
          {...buttonProps}
          title={labels.panDown}
          aria-label={labels.panDown}
          onClick={() => panBy(0, MERMAID_PAN_STEP)}
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </Button>
        <Button
          {...buttonProps}
          title={labels.zoomOut}
          aria-label={labels.zoomOut}
          onClick={() => panzoomRef.current?.zoomOut()}
        >
          <ZoomOut className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
