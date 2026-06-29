
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_SRC = join(import.meta.dir, '..', '..', 'src');
const REPO_RELATIVE_PREFIX = 'packages/app/src';

interface ClassPattern {
  readonly id: 'P1-fixed-inset-0' | 'P2-near-fullscreen-vw' | 'P3-top-banner';
  readonly regex: RegExp;
  readonly description: string;
}

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

const SAFE_AREA_AFFORDANCE_MARKERS = [
  'pl-[var(--ok-titlebar-reserve-left,1rem)]',
];

const SAFE_AREA_WRAPPER_FILES = new Set<string>();

interface AllowlistEntry {
  readonly file: string;
  readonly pattern: ClassPattern['id'];
  readonly rationale: string;
}

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
  const WINDOW = 6;
  const start = Math.max(0, hitLine - 1 - WINDOW);
  const end = Math.min(lines.length, hitLine - 1 + WINDOW + 1);
  const block = lines.slice(start, end).join('\n');
  if (SAFE_AREA_AFFORDANCE_MARKERS.some((marker) => block.includes(marker))) return true;
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
    const hits = findHits();
    const graphPanelHit = hits.find(
      (h) => h.file === 'components/GraphPanel.tsx' && h.pattern.id === 'P1-fixed-inset-0',
    );
    expect(graphPanelHit).toBeDefined();
  });
});
