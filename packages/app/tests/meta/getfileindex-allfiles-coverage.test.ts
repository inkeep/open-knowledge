/**
 * `getAllFilesIndex()` / `includeFiles` caller meta-test — static analysis gate.
 *
 * The watcher's
 * `getAllFilesIndex()` accessor exposes BOTH `kind:'markdown'` AND `kind:'file'`
 * entries; leaking a `kind:'file'` to a markdown-assuming consumer is a 1-way
 * door (CRDT persistence via `safeContentPath`, backlink wikilink parsing,
 * `registerDocExtension`, `getOrphans` mass-orphaning every `.png`, …).
 *
 * The default `getFileIndex()` accessor returns ONLY markdown via the
 * `markdownIndexView(...)` snapshot, so the ~16 markdown-assuming consumers
 * stay safe. This test enforces the polar opposite: every all-files call site
 * has been explicitly authorized — either by name in `ALLOWLISTED_SITES` (a
 * site genuinely designed to handle both kinds) or by a `kind`-discriminated
 * filter in the surrounding window.
 *
 * Modeled on `attribution-sweep-coverage.test.ts`. Same shape: scan source
 * for the dangerous call, walk back to the enclosing function, require either
 * allowlist OR a structural guard in the local window.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const API_EXT_PATH = join(SERVER_SRC_ROOT, 'api-extension.ts');
const FILE_WATCHER_PATH = join(SERVER_SRC_ROOT, 'file-watcher.ts');
// The composition root: it wires `watcher.getAllFilesIndex()` into the
// `createApiExtension({ getAllFilesIndex })` option exactly as it wires
// `getFileIndex` / `getFolderIndex` / `getAliasMap`. This is plumbing — it
// hands the accessor closure to api-extension; it never iterates file entries
// itself, so it cannot leak a `kind:'file'` entry to a markdown-assuming path.
const SERVER_FACTORY_PATH = join(SERVER_SRC_ROOT, 'server-factory.ts');

/**
 * Function-name allowlist for `getAllFilesIndex()` (or `includeFiles:true`)
 * call sites. Each entry should be one of the three sites the spec calls out
 * (corpus build / `/api/documents` / folder synthesis from all-files paths),
 * or a derivative immediately downstream of one of those.
 *
 * Adding a name here is the DELIBERATE act that authorizes a new all-files
 * site. Keep the rationale comment beside each entry; reviewers triage via
 * the comment, not the function name.
 */
const ALLOWLISTED_SITES: ReadonlySet<string> = new Set<string>([
  // Write accessor — the default `mutateFileIndex` fallback. It mutates the
  // live map keyed by docName and never reads or hands a `kind:'file'` entry
  // to a markdown-assuming consumer, so it cannot leak across the 1-way door.
  'applyDiskEventToLiveAllFilesIndex',
  // Future corpus-build site (will host `getAllFilesIndex()` once it
  // lands). Listed pre-emptively so the corpus PR is purely additive — no
  // allowlist edit interleaved with the corpus rewrite, no race between the
  // meta-test and the call-site migration.
  'buildWorkspaceSearchDocumentsFromIndex',
  'workspaceSearchFingerprint',
  // Future folder-synthesis derivative — the folder-synthesis pass currently
  // reads pages produced from the markdown index but will read all-files
  // folders once the corpus-build sites land.
  'deriveFolderSearchDocuments',
  // Future `/api/documents` payload site. The exact handler is
  // `handleDocumentList`; pre-allowlisted for the same reason as above.
  'handleDocumentList',
]);

/**
 * Identify the enclosing function name for a character offset. Walks back to
 * the nearest preceding `function NAME(` / `async function NAME(` /
 * `const NAME =` declaration. Returns `'<unknown>'` if none precedes the
 * offset — in practice impossible for the inside of `api-extension.ts`, but
 * a defensive fallback keeps the test's failure message readable.
 */
function findEnclosingFn(source: string, offset: number): string {
  const fragment = source.slice(0, offset);
  // Try function / async function declarations first (covers `handle*`,
  // `build*`, `derive*`, `_*` helpers, etc.). Match the LAST occurrence.
  // `const` matches handlers migrated to `withValidation(...)` (`handleDocumentList`
  // etc.) as well as bare arrow / async arrow forms.
  const fnMatches = [...fragment.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const constMatches = [...fragment.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\S/g)];
  const lastFn = fnMatches.length > 0 ? fnMatches[fnMatches.length - 1] : null;
  const lastConst = constMatches.length > 0 ? constMatches[constMatches.length - 1] : null;

  const fnIdx = lastFn?.index ?? -1;
  const constIdx = lastConst?.index ?? -1;
  if (fnIdx === -1 && constIdx === -1) return '<unknown>';
  if (fnIdx >= constIdx) return lastFn?.[1] ?? '<unknown>';
  return lastConst?.[1] ?? '<unknown>';
}

/**
 * True when the surrounding window narrows the all-files index by `kind`
 * (so the caller has explicitly opted into both `'markdown'` and `'file'`
 * and is treating them differently). Examples of accepted patterns:
 *   `entry.kind === 'markdown'`
 *   `entry.kind !== 'file'`
 *   `if (e.kind === 'markdown') {`
 *   `.filter((e) => e.kind === 'markdown')`
 * The test accepts ANY use of `.kind ===` / `.kind !==` against a string
 * literal within the window — the goal is "caller demonstrably reasoned
 * about kind", not exact-syntax matching.
 */
function windowFiltersOnKind(window: string): boolean {
  return /\.kind\s*(?:===|!==)\s*['"](markdown|file)['"]/.test(window);
}

interface CallSite {
  /** Path of the source file the call appears in (logging only). */
  file: string;
  /** 1-based line number for the call's start. */
  line: number;
  /** Function name the call sits inside. */
  fn: string;
  /** Local window around the call, used for the `.kind` filter check. */
  window: string;
}

function collectAllFilesCallSites(filePath: string): CallSite[] {
  const source = readFileSync(filePath, 'utf8');
  const sites: CallSite[] = [];
  for (const match of source.matchAll(/getAllFilesIndex\s*\(/g)) {
    const offset = match.index ?? 0;
    const line = source.slice(0, offset).split('\n').length;
    const fn = findEnclosingFn(source, offset);
    // Symmetric ~600-char window on either side. The "before" half catches
    // the rationale comment block agents conventionally write above the
    // call site — `handleDocumentList`'s rationale (the magic
    // `entry.kind === 'markdown'` phrase) sits ~230 chars upstream of the
    // call, just outside the previous 200-char window. The "after" half
    // catches the loop body where the actual `.kind ===` filter applies.
    const window = source.slice(Math.max(0, offset - 600), Math.min(source.length, offset + 600));
    sites.push({ file: filePath, line, fn, window });
  }
  return sites;
}

/** Recursively enumerate `.ts` files under `dir`, skipping test files. */
function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (st.isFile() && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('PRD-7117 US-002 — getAllFilesIndex caller coverage (D12 §13-A)', () => {
  test('every getAllFilesIndex() call site in api-extension.ts is allowlisted or kind-filtered', () => {
    const sites = collectAllFilesCallSites(API_EXT_PATH);
    const failures: string[] = [];
    for (const site of sites) {
      const allowed = ALLOWLISTED_SITES.has(site.fn);
      const filtered = windowFiltersOnKind(site.window);
      if (!allowed && !filtered) {
        failures.push(
          `${site.file}:${site.line} — enclosing fn "${site.fn}" is neither on ALLOWLISTED_SITES nor narrows on \`.kind\`. ` +
            'A new getAllFilesIndex() consumer must be added to ALLOWLISTED_SITES (with rationale) ' +
            'OR must structurally guard via `entry.kind === "markdown"` / similar inside the call site.',
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test('getAllFilesIndex() is not called from any other server-side production file', () => {
    // file-watcher.ts is allowed (it defines the accessor); api-extension.ts
    // is the only allowed data CONSUMER (and it threads through allowlisted
    // sites only); server-factory.ts is the allowed WIRING site (composition
    // root — passes the accessor closure into createApiExtension, never reads
    // entries). Every other production file must call `getFileIndex()` and
    // observe the markdown-only view. This prevents a future module from
    // silently bypassing the allowlist by reaching for the all-files accessor
    // directly to consume non-markdown entries.
    //
    // Scope is intentionally server-side only. `getAllFilesIndex` is a
    // `WatcherHandle` method (and the matching `ApiExtensionOptions` field) —
    // never exported across package boundaries, so `packages/app/**` and
    // `packages/core/**` cannot call it (the only cross-package mention is a
    // doc comment in app's file-tree-utils). A cross-layer leak is therefore
    // structurally impossible without first adding a server export, which this
    // server-scoped scan would catch at that export site.
    const allowedFiles = new Set([FILE_WATCHER_PATH, API_EXT_PATH, SERVER_FACTORY_PATH]);
    const offenders: string[] = [];
    for (const file of listProductionTsFiles(SERVER_SRC_ROOT)) {
      if (allowedFiles.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      if (/getAllFilesIndex\s*\(/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('ALLOWLISTED_SITES function names actually exist in api-extension.ts', () => {
    // Guard against allowlist rot: if a site is renamed or removed without
    // updating ALLOWLISTED_SITES, the entry becomes a dead authorization.
    const source = readFileSync(API_EXT_PATH, 'utf8');
    const missing: string[] = [];
    for (const name of ALLOWLISTED_SITES) {
      const fnRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
      const constRe = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\S`);
      if (!fnRe.test(source) && !constRe.test(source)) {
        missing.push(
          `${name}: function declaration not found in api-extension.ts — either rename/remove dropped the site, ` +
            'or the allowlist entry is stale.',
        );
      }
    }
    expect(missing).toEqual([]);
  });
});
