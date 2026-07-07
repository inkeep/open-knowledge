/**
 * Class-level regression guard for the macOS-traffic-light safe-area
 * contract on in-window full-viewport overlays.
 *
 * Class invariant: any renderer-drawn overlay that occupies the
 * `trafficLightPosition: { x: 22, y: 24 }` coordinate region while the
 * Electron desktop runs with `titleBarStyle: 'hiddenInset'` MUST reserve
 * the top-left safe area (≥ traffic-light footprint + margin). Without the
 * reserve, the OS-drawn close/minimize/zoom buttons visually overlap the
 * renderer's interactive chrome (titles, counts, toggles, action buttons).
 *
 * Primary instance: `GraphPanel.tsx`'s expanded state (`isExpanded`).
 * Class siblings:
 *   - `ConnectingBanner.tsx` full-width banners — adopt the safe-area
 *     marker with a web-safe fallback (`pl-[var(--ok-titlebar-reserve-left,1rem)]`).
 *     In Electron the content clears the traffic-light footprint; on web
 *     the variable is undefined and the `1rem` fallback restores the
 *     original `px-4` left padding (a bare no-fallback `var()` would be
 *     invalid-at-computed-value-time and collapse `padding-left` to 0).
 *
 * Each match of the three class patterns MUST be either:
 *   (a) on the explicit allowlist below (with rationale tying the entry
 *       to a cosmetic-only outcome OR a Radix backdrop-pattern), OR
 *   (b) carrying a known safe-area affordance from
 *       `SAFE_AREA_AFFORDANCE_MARKERS` on the same line OR within a
 *       small context window (symmetric ±6 lines, for cn()-composed
 *       classNames on sibling lines).
 *
 * If a wrapper-component shape is later introduced, the wrapper's own
 * definition file (e.g. `packages/app/src/components/ui/fullscreen-overlay.tsx`)
 * should be added to the allowlist — the wrapper's INTERNAL `fixed
 * inset-0` is the one place the class pattern is legitimately expressed.
 *
 * Codebase-grep test idiom — mirrors `no-sync-set-enabled-references.test.ts`,
 * `keyboard-nav-catch-contract.test.ts`, and the other `tests/integration/`
 * scanners. Fast, no I/O beyond filesystem walk, deterministic in headless CI.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_SRC = join(import.meta.dir, '..', '..', 'src');
const REPO_RELATIVE_PREFIX = 'packages/app/src';

interface ClassPattern {
  /** Short label used in error messages. */
  readonly id: 'P1-fixed-inset-0' | 'P2-near-fullscreen-vw' | 'P3-top-banner';
  /** Regex matching the bug-class className substring. */
  readonly regex: RegExp;
  /** Human description for error messages. */
  readonly description: string;
}

/**
 * The three className patterns that span the macOS-traffic-light region.
 *
 *   - P1 `fixed inset-0` — full-viewport overlays. Includes Radix
 *     Dialog.Overlay / Sheet.Overlay (backdrops, allowlisted by file:line
 *     below).
 *   - P2 `w-[Nvw]` with N≥90 — near-fullscreen centered dialogs whose
 *     bare top-left corner extends into the traffic-light region (top
 *     edge at y≈viewport_height × (100-N)/2/100 — at 96vh that's y≈16,
 *     INSIDE the traffic-light y-band 18..30).
 *   - P3 `fixed top-0 inset-x-0` — full-width banners pinned to the top
 *     edge whose background spans the traffic-light x-band 22..~100.
 */
const CLASS_PATTERNS: readonly ClassPattern[] = [
  {
    id: 'P1-fixed-inset-0',
    regex: /fixed\s+inset-0\b/,
    description: 'full-viewport overlay (fixed inset-0)',
  },
  {
    id: 'P2-near-fullscreen-vw',
    regex: /\bw-\[\s*9[0-9]\s*vw\]/,
    description: 'near-fullscreen centered dialog (w-[Nvw], N≥90)',
  },
  {
    id: 'P3-top-banner',
    regex: /fixed\s+top-0\s+inset-x-0\b/,
    description: 'full-width top banner (fixed top-0 inset-x-0)',
  },
];

/**
 * Tokens that, when present on the same line as a class-pattern match (or
 * within a small lookahead/lookbehind for cn()-composed classNames), prove
 * the consumer has opted into the safe-area contract.
 *
 * Same set as the `GraphPanel.fullscreen-safe-area.test.ts`
 * allowlist — keep in lockstep.
 */
const SAFE_AREA_AFFORDANCE_MARKERS = [
  // Trimmed to shapes that exist in the codebase. Extend in lockstep with
  // GraphPanel.fullscreen-safe-area.test.ts's SAFE_AREA_AFFORDANCES when a
  // new shape lands; never pre-register speculative shapes (they widen the
  // disjunction so every site appears compliant by accident). The bare
  // `pl-[78px]` literal was retired when EditorHeader adopted the shared
  // `--ok-titlebar-reserve-left` token — no live site uses it anymore.
  'pl-[var(--ok-titlebar-reserve-left,1rem)]',
];

/**
 * Wrapper-component names whose internal definition site is allowed to
 * express the bug-class className pattern. The wrappers encapsulate the
 * safe-area treatment so consumers can opt in via JSX composition rather
 * than direct className manipulation.
 *
 * Each entry must point to the wrapper's own source file relative to
 * APP_SRC. The class-pattern match inside the wrapper is the legitimate
 * site; consumers (JSX users) are detected via the marker tokens above.
 *
 * Currently empty — the safe-area substrate is a CSS variable + arbitrary-
 * value Tailwind utility, not a wrapper component. If a wrapper shape is
 * later introduced, add its source file here in the same commit (so the
 * wrapper's internal `fixed inset-0` is not flagged as an offender).
 */
const SAFE_AREA_WRAPPER_FILES = new Set<string>();

interface AllowlistEntry {
  /** Project-relative path under packages/app/src. */
  readonly file: string;
  /** Which pattern this entry exempts. */
  readonly pattern: ClassPattern['id'];
  /** Justification — why this site does not need a safe-area utility. */
  readonly rationale: string;
}

/**
 * Explicit exemptions. Every entry MUST cite a rationale that connects to
 * one of:
 *   (a) Radix overlay backdrop pattern — `fixed inset-0` is the
 *       backdrop dimmer, not a content carrier. Interactive content lives
 *       in DialogContent/SheetContent which is centered with its own
 *       padding.
 *   (b) Cosmetic-only — the surface extends into the traffic-light region
 *       but no interactive control is overlapped.
 *
 * Extending this list is a structural decision that should be reviewed
 * — prefer migration to the safe-area-aware wrapper when feasible.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    file: 'components/ui/dialog.tsx',
    pattern: 'P1-fixed-inset-0',
    rationale: 'Radix Dialog.Overlay backdrop — no interactive content',
  },
  {
    file: 'components/ui/sheet.tsx',
    pattern: 'P1-fixed-inset-0',
    rationale: 'Radix Sheet.Overlay backdrop — no interactive content',
  },
  // Removed entries for InternalLinkPropPanel.tsx + WikiLinkPropPanel.tsx —
  // both PropPanels migrated their inline EditMarkdownLinkDialog /
  // EditWikiLinkDialog from raw radix-ui Dialog.* primitives to the shared
  // shadcn Dialog wrapper (which already lives in the allowlist via
  // components/ui/dialog.tsx). The inline `fixed inset-0` overlay
  // declarations these entries pointed at no longer exist.
  // Removed entry for ConflictResolver.tsx — the side-sheet was deleted
  // when the editor-area DiffViewBoundary became the only UI conflict-
  // resolution surface; the sidebar Conflicts section provides project-
  // level navigation.
];

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (
      entry.endsWith('.tsx') &&
      // Tests reference the class-pattern strings via .not.toContain assertions
      // or scanner regexes — intentional regression guards, not real consumers.
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.dom.test.tsx')
    ) {
      yield full;
    }
  }
}

interface PatternHit {
  readonly file: string;
  readonly line: number;
  readonly lineText: string;
  readonly pattern: ClassPattern;
}

function findHits(): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const file of walkSourceFiles(APP_SRC)) {
    const relPath = file
      .slice(APP_SRC.length + 1)
      .split('/')
      .join('/'); // posix-style for matching against ALLOWLIST entries
    const contents = readFileSync(file, 'utf-8');
    const lines = contents.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? '';
      for (const pattern of CLASS_PATTERNS) {
        if (pattern.regex.test(lineText)) {
          hits.push({ file: relPath, line: i + 1, lineText, pattern });
        }
      }
    }
  }
  return hits;
}

function hasSafeAreaMarker(file: string, lines: string[], hitLine: number): boolean {
  // The Tailwind utility / variant / CSS-var marker may appear on the same
  // line as the className declaration OR within a small context window
  // (symmetric ±6 lines) when cn() composes multiple class strings across
  // sibling lines. Keep the window tight to avoid false positives from
  // unrelated code.
  const WINDOW = 6;
  const start = Math.max(0, hitLine - 1 - WINDOW);
  const end = Math.min(lines.length, hitLine - 1 + WINDOW + 1);
  const block = lines.slice(start, end).join('\n');
  if (SAFE_AREA_AFFORDANCE_MARKERS.some((marker) => block.includes(marker))) return true;
  // Wrapper file itself — the class pattern is legitimately expressed
  // inside the wrapper definition.
  if (SAFE_AREA_WRAPPER_FILES.has(file)) return true;
  return false;
}

function isAllowlisted(hit: PatternHit): AllowlistEntry | undefined {
  return ALLOWLIST.find((e) => e.file === hit.file && e.pattern === hit.pattern.id);
}

describe('Fullscreen-overlay safe-area class invariant (Electron + macOS)', () => {
  test('every fixed inset-0 / w-[Nvw] / fixed top-0 inset-x-0 site is on the allowlist OR adopts a safe-area marker', () => {
    const hits = findHits();
    const offenders: Array<{
      hit: PatternHit;
      reason: string;
    }> = [];

    // Cache file contents to re-read for marker lookup.
    const fileCache = new Map<string, string[]>();
    function getLines(file: string): string[] {
      const cached = fileCache.get(file);
      if (cached) return cached;
      const absPath = join(APP_SRC, file);
      const lines = readFileSync(absPath, 'utf-8').split('\n');
      fileCache.set(file, lines);
      return lines;
    }

    for (const hit of hits) {
      const allowlistEntry = isAllowlisted(hit);
      if (allowlistEntry) continue;
      const lines = getLines(hit.file);
      if (hasSafeAreaMarker(hit.file, lines, hit.line)) continue;
      offenders.push({
        hit,
        reason: `no allowlist entry, no safe-area marker within ±6 lines`,
      });
    }

    if (offenders.length > 0) {
      const lines = [
        `${offenders.length} class-pattern site(s) lack the macOS-traffic-light safe-area contract:`,
        '',
        ...offenders.map(({ hit, reason }) => {
          return [
            `  ${REPO_RELATIVE_PREFIX}/${hit.file}:${hit.line}  [${hit.pattern.id}: ${hit.pattern.description}]`,
            `    ${hit.lineText.trim()}`,
            `    → ${reason}`,
          ].join('\n');
        }),
        '',
        'To resolve each offender, do ONE of:',
        '  1. Add a safe-area marker on the same line (or within 6 lines):',
        SAFE_AREA_AFFORDANCE_MARKERS.map((m) => `       - "${m}"`).join('\n'),
        '  2. If a wrapper component encapsulates the safe-area treatment, route the JSX through it',
        '     and ensure the wrapper file is in SAFE_AREA_WRAPPER_FILES.',
        '  3. If the site is provably cosmetic-only (no interactive control in',
        '     the traffic-light region), add an explicit ALLOWLIST entry with',
        '     a rationale that cites the coordinate-space proof.',
      ];
      throw new Error(lines.join('\n'));
    }

    expect(offenders).toEqual([]);
  });

  test('allowlist entries reference real files and real class patterns', () => {
    // Defense-in-depth: a stale allowlist (entry for a deleted file or a
    // file that no longer matches its pattern) would silently disable the
    // contract for that pattern site. Each ALLOWLIST entry must continue
    // to correspond to a real hit.
    const hits = findHits();
    const stale: AllowlistEntry[] = [];
    for (const entry of ALLOWLIST) {
      const matches = hits.some((h) => h.file === entry.file && h.pattern.id === entry.pattern);
      if (!matches) stale.push(entry);
    }
    if (stale.length > 0) {
      const lines = [
        `${stale.length} allowlist entry/entries no longer correspond to a real class-pattern hit:`,
        '',
        ...stale.map(
          (e) =>
            `  ${REPO_RELATIVE_PREFIX}/${e.file}  [${e.pattern}]\n    rationale: ${e.rationale}`,
        ),
        '',
        'Either remove the stale entry (the file or pattern is gone — good!)',
        'or fix the path/pattern if it was renamed.',
      ];
      throw new Error(lines.join('\n'));
    }
    expect(stale).toEqual([]);
  });

  test('the GraphPanel.tsx fullscreen overlay is detected as a class-pattern site', () => {
    // Sanity check: the scanner actually detects GraphPanel's expanded-state
    // overlay as a P1-fixed-inset-0 site. Guards against the scanner silently
    // matching nothing (which would let the offenders test pass vacuously).
    const hits = findHits();
    const graphPanelHit = hits.find(
      (h) => h.file === 'components/GraphPanel.tsx' && h.pattern.id === 'P1-fixed-inset-0',
    );
    expect(graphPanelHit).toBeDefined();
  });
});
