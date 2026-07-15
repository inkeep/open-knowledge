/**
 * Project-wide + single-doc lint, server-side. Walks the content directory
 * (honoring `.gitignore`/`.okignore` via `createContentFilter`), resolves the
 * effective config (project base + native `.markdownlint.*` rules), and lints
 * with the core engine. Backs the `/api/lint` + `/api/lint/audit` endpoints
 * (Settings audit button + MCP `lint` tool + write-response warnings).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  fixDocument,
  type LintDiagnostic,
  type LinterConfig,
  lintDocument,
  SUPPORTED_DOC_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import { SymlinkEscapeError } from '../apply-managed-rename.ts';
import { createContentFilter } from '../content-filter.ts';
import { isWithinContentDir } from '../persistence.ts';
import { resolveEffectiveLinterConfig } from './resolve-config.ts';

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

export interface AuditOptions {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
}

/** Lint a single document (read from disk) with its per-doc effective config. */
export async function lintDoc(
  opts: AuditOptions & { docRelPath: string; onConfigProblem?: (problem: string) => void },
): Promise<FileLintResult> {
  const { contentDir, baseConfig, docRelPath, onConfigProblem } = opts;
  // Symlinks inside the content dir are supported (realpath-based identity),
  // but an escape must be refused before the read: lint diagnostics echo
  // source text, so linting an escaped symlink is an arbitrary-file read.
  const canonical = resolveCanonicalDocPath(join(contentDir, docRelPath), contentDir);
  const text = readFileSync(canonical, 'utf-8');
  const cfg = resolveEffectiveLinterConfig(contentDir, baseConfig, {
    docName: docRelPath,
    onProblem: onConfigProblem,
  });
  return { file: docRelPath, diagnostics: await lintDocument(text, cfg, docRelPath) };
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
  const { contentDir, baseConfig, docRelPath, source, onConfigProblem } = opts;
  const cfg = resolveEffectiveLinterConfig(contentDir, baseConfig, {
    docName: docRelPath,
    onProblem: onConfigProblem,
  });
  const before = await lintDocument(source, cfg, docRelPath);
  const fixed = fixDocument(source, cfg);
  return { cfg, before, fixed };
}

/** Lint every in-scope `.md`/`.mdx` document under `contentDir` (or a sub-path). */
export async function auditProject(
  opts: AuditOptions & { targetPath?: string },
): Promise<AuditResult> {
  const { projectDir, contentDir, baseConfig, targetPath } = opts;
  const warnings: string[] = [];
  const filter = createContentFilter({ projectDir, contentDir });

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
    walk(scope.path);
  }

  function walk(absDir: string): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`could not read ${relative(contentDir, absDir) || '.'}: ${errMsg(e)}`);
      return;
    }
    for (const entry of entries) {
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
  for (const rel of docFiles) {
    let result: FileLintResult;
    try {
      result = await lintDoc({
        projectDir,
        contentDir,
        baseConfig,
        docRelPath: rel,
        onConfigProblem,
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
