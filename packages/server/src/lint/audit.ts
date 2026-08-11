/**
 * Project-wide + single-doc lint, server-side. Walks the content directory
 * (honoring `.gitignore`/`.okignore` via `createContentFilter`), resolves the
 * effective config (project base + native `.markdownlint.*` rules), and lints
 * with the core engine. Backs the `/api/lint` + `/api/lint/audit` endpoints
 * (Settings audit button + MCP `lint` tool + write-response warnings).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  fixDocument,
  type LintDiagnostic,
  type LinterConfig,
  lintDocument,
  SUPPORTED_DOC_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import { SymlinkEscapeError } from '../apply-managed-rename.ts';
import { createContentFilter } from '../content-filter.ts';
import { isWithinContentDir } from '../content-path.ts';
import { AuditCache } from './audit-cache.ts';
import { unmatchedAppliesToProblems } from './frontmatter-schemas.ts';
import { composeFrontmatterSchemasConfig, resolveEffectiveLinterConfig } from './resolve-config.ts';

export interface FileLintResult {
  /** Path relative to `contentDir`. */
  file: string;
  diagnostics: LintDiagnostic[];
}

export interface AuditResult {
  files: FileLintResult[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  warnings: string[];
}

/**
 * Raised when the world the walk was linting changed underneath it — the lint
 * configuration, or the branch whose content it was reading. Either way the
 * walk's own result would mix docs from both sides of the change, so the
 * caller must discard it rather than publish a plane that is true of no
 * single configuration and no single branch.
 */
export class AuditSupersededError extends Error {
  constructor(message = 'the lint configuration or branch changed during the audit walk') {
    super(message);
    this.name = 'AuditSupersededError';
  }
}

/**
 * How long the walk may hold the loop between yields. Time-sliced rather than
 * every-N-documents because per-doc cost spans orders of magnitude (a stub vs
 * a thousand-line doc under every rule), so a fixed count gives slices whose
 * length is unbounded in the worst case.
 *
 * At this size a whole-project walk gives up the loop tens of times per second
 * — enough that HTTP requests, CC1 signals, fs-watcher events and persistence
 * timers keep being serviced — for a few percent of added wall time.
 *
 * It is a floor, not a ceiling: the yield sits between documents, so a single
 * document costlier than the slice still holds the loop for its own duration.
 * Going finer would need the lint engines themselves to become interruptible.
 */
const YIELD_SLICE_MS = 8;

export interface AuditOptions {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
  /**
   * Live CRDT source for a currently-loaded doc, else null. When provided,
   * loaded docs lint against the bytes the editor and the fix endpoint see —
   * not the disk file, which lags the CRDT behind the persistence debounce
   * (and lies outright if a flush was lost). Without this overlay a
   * disk/CRDT divergence wedges the Fix all sweep: the audit keeps reporting
   * problems the live doc no longer has, and every "fix" is a clean no-op.
   */
  liveSourceFor?: (docRelPath: string) => string | null;
  /**
   * Reuse per-file results across audits at unchanged config. Omitted → every
   * doc is re-linted. Docs served from `liveSourceFor` bypass it regardless:
   * their bytes move without touching the disk stamp the key rests on.
   */
  cache?: AuditCache;
  /**
   * Reads a token naming the world this walk's plane would be true of: the
   * lint configuration in force AND the branch whose content is on disk.
   * Injected rather than imported so this module stays free of server HTTP
   * state. Compared for equality only — a branch label has no order — so it is
   * a token, not a counter.
   *
   * Both inputs move underneath a walk. The walk resolves the native
   * `.markdownlint.*` cascade per document, so a config write landing between
   * two of its yields would leave earlier docs linted under the old rules and
   * later ones under the new; a branch switch replaces the content set
   * wholesale on disk, so one landing mid-walk leaves earlier docs read from
   * the old branch and later ones from the new. Either way the result is a
   * plane true of no single world. Sampled at each yield; a move abandons the
   * walk with {@link AuditSupersededError}. Omitted → no supersession check,
   * which is correct for callers that cannot observe either change.
   */
  auditGeneration?: () => string;
}

/** Lint a single document (live CRDT source when loaded, else disk) with its
 *  per-doc effective config. */
export async function lintDoc(
  opts: AuditOptions & { docRelPath: string; onConfigProblem?: (problem: string) => void },
): Promise<FileLintResult> {
  const { projectDir, contentDir, baseConfig, docRelPath, onConfigProblem, liveSourceFor, cache } =
    opts;
  const live = liveSourceFor?.(docRelPath) ?? null;
  // Resolved before the cache probe because the resolved config IS part of the
  // key — and unconditionally, so a config-resolution problem still reaches
  // `onConfigProblem` on a cache hit (the audit aggregates those into its
  // top-level warnings, which must not thin out as the cache warms).
  const cfg = resolveEffectiveLinterConfig(contentDir, baseConfig, {
    docName: docRelPath,
    projectDir,
    onProblem: onConfigProblem,
  });
  if (live !== null) {
    return { file: docRelPath, diagnostics: await lintDocument(live, cfg, docRelPath) };
  }
  // Symlinks inside the content dir are supported (realpath-based identity),
  // but an escape must be refused before the read: lint diagnostics echo
  // source text, so linting an escaped symlink is an arbitrary-file read.
  const canonical = resolveCanonicalDocPath(join(contentDir, docRelPath), contentDir);
  let cacheKey: string | null = null;
  if (cache !== undefined) {
    // A missing/unreadable stamp just skips the cache — the read below reports
    // the real failure, and guessing a key would be worse than re-linting.
    try {
      const stat = statSync(canonical);
      cacheKey = AuditCache.key({
        contentDir,
        docRelPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        configFingerprint: AuditCache.fingerprintConfig(cfg),
      });
    } catch {
      cacheKey = null;
    }
    if (cacheKey !== null) {
      const cached = cache.get(cacheKey);
      if (cached !== null) return { file: docRelPath, diagnostics: cached };
    }
  }
  const text = readFileSync(canonical, 'utf-8');
  const diagnostics = await lintDocument(text, cfg, docRelPath);
  if (cacheKey !== null) cache?.set(cacheKey, diagnostics);
  return { file: docRelPath, diagnostics };
}

/**
 * Lint + auto-fix a single document's LIVE source text (frontmatter + body).
 * The `/api/lint/fix` handler passes the in-memory CRDT source (not disk) and
 * lands `fixed` through the agent-write spine, so this stays a pure string
 * compute that shares the engine + per-doc config resolution with `lintDoc`.
 * `fixDocument` delegates to upstream markdownlint's `applyFixes` — we author no
 * fix logic. Returns `cfg` so the caller can re-lint the post-write source for
 * the remaining set without re-resolving config.
 */
export async function lintAndFixSource(
  opts: AuditOptions & {
    docRelPath: string;
    source: string;
    onConfigProblem?: (problem: string) => void;
  },
): Promise<{ cfg: LinterConfig; before: LintDiagnostic[]; fixed: string }> {
  const { projectDir, contentDir, baseConfig, docRelPath, source, onConfigProblem } = opts;
  const cfg = resolveEffectiveLinterConfig(contentDir, baseConfig, {
    docName: docRelPath,
    projectDir,
    onProblem: onConfigProblem,
  });
  const before = await lintDocument(source, cfg, docRelPath);
  const fixed = fixDocument(source, cfg);
  return { cfg, before, fixed };
}

/**
 * Enumerate every in-scope `.md`/`.mdx` document under `scopeDir` (default:
 * all of `contentDir`) as content-relative paths — the same walk the audit
 * lints over (ignore rules, hidden-segment skips, extension gate), exposed so
 * doc-independent checks (unmatched appliesTo globs on the lint-config
 * surface) agree with the audit about what counts as a doc.
 */
export function collectDocFiles(opts: {
  projectDir: string;
  contentDir: string;
  scopeDir?: string;
  onWarning?: (warning: string) => void;
}): string[] {
  const { projectDir, contentDir, scopeDir, onWarning } = opts;
  const filter = createContentFilter({ projectDir, contentDir });
  const docFiles: string[] = [];

  function walk(absDir: string): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      onWarning?.(`could not read ${relative(contentDir, absDir) || '.'}: ${errMsg(e)}`);
      return;
    }
    for (const entry of entries) {
      // Hidden segments (.ok/, .git/, .obsidian/, dotfiles) are not
      // addressable as docNames (see `validateDocName`), so a diagnostic here
      // could be neither navigated to nor auto-fixed — the fix endpoint
      // rejects the docName outright. Skip them so the audit's scope stays
      // symmetric with the write path's addressability (precedent #55).
      if (entry.name.startsWith('.')) continue;
      const full = join(absDir, entry.name);
      const rel = relative(contentDir, full);
      if (entry.isDirectory()) {
        if (filter.isDirExcluded(rel)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!isDocFile(entry.name)) continue;
        if (filter.isExcluded(rel)) continue;
        docFiles.push(rel);
      }
    }
  }

  walk(scopeDir ?? contentDir);
  return docFiles;
}

/** Lint every in-scope `.md`/`.mdx` document under `contentDir` (or a sub-path). */
export async function auditProject(
  opts: AuditOptions & { targetPath?: string },
): Promise<AuditResult> {
  const { projectDir, contentDir, baseConfig, targetPath, auditGeneration } = opts;
  const warnings: string[] = [];
  // Sampled before the first yield, so it is the generation every doc in this
  // walk is linted under until proven otherwise.
  const startGeneration = auditGeneration?.();

  const docFiles: string[] = [];
  const scope = resolveScope(targetPath, contentDir);
  // Defense-in-depth behind the HTTP boundary's relative-path validation: a
  // scope that resolves outside contentDir is refused, never walked — audit
  // output quotes document text, so an escaped walk is an arbitrary read.
  // The refusal must be realpath-based, not just lexical: a symlinked scope
  // directory would otherwise be readdir'd, and although every file read
  // inside is refused, the per-file refusal warnings would enumerate the
  // external filenames. Refuse once, before walking, naming no entries.
  const scopeRel = relative(contentDir, scope.path);
  if (scopeRel.startsWith('..') || isAbsolute(scopeRel)) {
    warnings.push(`refusing audit scope outside the content directory: ${targetPath ?? ''}`);
    return { files: [], fileCount: 0, errorCount: 0, warningCount: 0, warnings };
  }
  // Same hidden-segment rule the walk applies per entry: a scope like
  // `.ok/skills` names docs the write path cannot address, so auditing it
  // would produce unfixable, unnavigable rows.
  if (scopeRel.split('/').some((segment) => segment.startsWith('.'))) {
    warnings.push(`refusing audit scope under a hidden path segment: ${targetPath ?? ''}`);
    return { files: [], fileCount: 0, errorCount: 0, warningCount: 0, warnings };
  }
  try {
    if (!isWithinContentDir(realpathSync(scope.path), realpathSync(contentDir))) {
      warnings.push(`symlink-escape: audit scope resolves outside the content directory`);
      return { files: [], fileCount: 0, errorCount: 0, warningCount: 0, warnings };
    }
  } catch {
    // Scope path missing or unreadable: fall through — the walk/read reports it.
  }
  if (scope.kind === 'file') {
    docFiles.push(relative(contentDir, scope.path));
  } else {
    docFiles.push(
      ...collectDocFiles({
        projectDir,
        contentDir,
        scopeDir: scope.path,
        onWarning: (warning) => warnings.push(warning),
      }),
    );
  }

  docFiles.sort();

  const files: FileLintResult[] = [];
  let errorCount = 0;
  let warningCount = 0;
  // Config problems repeat for every doc a governing file covers — dedupe.
  const seenConfigProblems = new Set<string>();
  const onConfigProblem = (problem: string) => {
    if (seenConfigProblems.has(problem)) return;
    seenConfigProblems.add(problem);
    warnings.push(problem);
  };
  // Frontmatter schema loading is doc-independent — resolve once for the whole
  // audit; the per-doc resolution sees resolved entries and skips the reads.
  const auditBase = composeFrontmatterSchemasConfig(projectDir, baseConfig, onConfigProblem);
  // Zero-match globs only make sense against the FULL doc set — a sub-path
  // audit would flag every pattern scoped to a folder outside the target.
  const fmSlice = auditBase.plugins.frontmatter;
  if ((targetPath === undefined || targetPath === '') && fmSlice.enabled) {
    for (const problem of unmatchedAppliesToProblems(fmSlice.schemas, docFiles)) {
      onConfigProblem(problem);
    }
  }
  let sliceStartedAt = performance.now();
  for (const rel of docFiles) {
    if (performance.now() - sliceStartedAt >= YIELD_SLICE_MS) {
      // A macrotask, not a microtask: `await Promise.resolve()` (or an async
      // callee that never awaits real I/O, which is what the lint engines are)
      // drains on the same turn and never lets the loop reach its poll phase.
      await yieldToEventLoop();
      if (auditGeneration !== undefined && auditGeneration() !== startGeneration) {
        throw new AuditSupersededError();
      }
      sliceStartedAt = performance.now();
    }
    let result: FileLintResult;
    try {
      result = await lintDoc({
        projectDir,
        contentDir,
        baseConfig: auditBase,
        docRelPath: rel,
        onConfigProblem,
        liveSourceFor: opts.liveSourceFor,
        cache: opts.cache,
      });
    } catch (e) {
      warnings.push(`could not lint ${rel}: ${errMsg(e)}`);
      continue;
    }
    for (const d of result.diagnostics) {
      if (d.severity === 'error') errorCount++;
      else warningCount++;
    }
    // Only include files that actually have diagnostics in the audit payload.
    if (result.diagnostics.length > 0) files.push(result);
  }

  // Small corpora may finish without crossing the time-slice yield above. The
  // final equality check keeps every audit size supersession-safe.
  if (auditGeneration !== undefined && auditGeneration() !== startGeneration) {
    throw new AuditSupersededError();
  }

  return { files, fileCount: docFiles.length, errorCount, warningCount, warnings };
}

/**
 * Realpath-resolve a doc path and refuse it when the canonical location falls
 * outside the canonical content dir (comparing realpaths on both sides keeps
 * platform aliases like macOS `/var` → `/private/var` from false-positives).
 */
function resolveCanonicalDocPath(abs: string, contentDir: string): string {
  const canonicalContentDir = realpathSync(contentDir);
  let canonical: string;
  try {
    canonical = realpathSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new SymlinkEscapeError('symlink cycle in path');
    }
    throw e;
  }
  if (!isWithinContentDir(canonical, canonicalContentDir)) {
    throw new SymlinkEscapeError('path resolves outside content directory');
  }
  return canonical;
}

type Scope = { kind: 'dir' | 'file'; path: string };

function resolveScope(targetPath: string | undefined, contentDir: string): Scope {
  if (targetPath === undefined || targetPath === '') return { kind: 'dir', path: contentDir };
  const abs = isAbsolute(targetPath) ? targetPath : resolve(contentDir, targetPath);
  try {
    if (statSync(abs).isFile()) return { kind: 'file', path: abs };
  } catch {
    // treat as a directory; the walk warns if unreadable.
  }
  return { kind: 'dir', path: abs };
}

function isDocFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
