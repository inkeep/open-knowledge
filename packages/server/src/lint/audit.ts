import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  AUDIT_EMPTY_SCOPE_WARNING,
  deriveValidationRunSources,
  fixDocument,
  type LintDiagnostic,
  type LinterConfig,
  type LintPluginFailure,
  type LintPluginId,
  lintDocument,
  SUPPORTED_DOC_EXTENSIONS,
  summarizeLintPluginFailures,
} from '@inkeep/open-knowledge-core';
import { SymlinkEscapeError } from '../apply-managed-rename.ts';
import { createContentFilter } from '../content-filter.ts';
import { isWithinContentDir } from '../content-path.ts';
import { AuditCache } from './audit-cache.ts';
import { type AuditScope, resolveAuditScope } from './audit-scope.ts';
import { unmatchedAppliesToProblems } from './frontmatter-schemas.ts';
import { composeFrontmatterSchemasConfig, resolveEffectiveLinterConfig } from './resolve-config.ts';

interface FileLintResult {
  file: string;
  diagnostics: LintDiagnostic[];
}

interface LintDocRunResult extends FileLintResult {
  ran: LintPluginId[];
  failures: LintPluginFailure[];
}

export interface AuditResult {
  files: FileLintResult[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  warnings: string[];
  ran: LintPluginId[];
}

export class AuditSupersededError extends Error {
  constructor(message = 'the lint configuration or branch changed during the audit walk') {
    super(message);
    this.name = 'AuditSupersededError';
  }
}

const YIELD_SLICE_MS = 8;

export interface AuditOptions {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
  liveSourceFor?: (docRelPath: string) => string | null;
  cache?: AuditCache;
  auditGeneration?: () => string;
  resolvedScope?: AuditScope;
}

export async function lintDoc(
  opts: AuditOptions & { docRelPath: string; onConfigProblem?: (problem: string) => void },
): Promise<LintDocRunResult> {
  const { projectDir, contentDir, baseConfig, docRelPath, onConfigProblem, liveSourceFor, cache } =
    opts;
  const live = liveSourceFor?.(docRelPath) ?? null;
  const cfg = resolveEffectiveLinterConfig(contentDir, baseConfig, {
    docName: docRelPath,
    projectDir,
    onProblem: onConfigProblem,
  });
  const ran = deriveValidationRunSources(cfg, { mode: 'lint' });
  const failures: LintPluginFailure[] = [];
  const onPluginFailure = (failure: LintPluginFailure): void => {
    failures.push(failure);
  };
  if (live !== null) {
    return {
      file: docRelPath,
      diagnostics: await lintDocument(live, cfg, docRelPath, onPluginFailure),
      ran,
      failures,
    };
  }
  const canonical = resolveCanonicalDocPath(join(contentDir, docRelPath), contentDir);
  let cacheKey: string | null = null;
  if (cache !== undefined) {
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
      if (cached !== null) return { file: docRelPath, diagnostics: cached, ran, failures };
    }
  }
  const text = readFileSync(canonical, 'utf-8');
  const diagnostics = await lintDocument(text, cfg, docRelPath, onPluginFailure);
  if (cacheKey !== null && failures.length === 0) cache?.set(cacheKey, diagnostics);
  return { file: docRelPath, diagnostics, ran, failures };
}

export async function lintAndFixSource(
  opts: AuditOptions & {
    docRelPath: string;
    source: string;
    onConfigProblem?: (problem: string) => void;
  },
): Promise<{
  cfg: LinterConfig;
  before: LintDiagnostic[];
  fixed: string;
  ran: LintPluginId[];
  failures: LintPluginFailure[];
}> {
  const { projectDir, contentDir, baseConfig, docRelPath, source, onConfigProblem } = opts;
  const cfg = resolveEffectiveLinterConfig(contentDir, baseConfig, {
    docName: docRelPath,
    projectDir,
    onProblem: onConfigProblem,
  });
  const ran = deriveValidationRunSources(cfg, { mode: 'lint' });
  const failures: LintPluginFailure[] = [];
  const onPluginFailure = (failure: LintPluginFailure): void => {
    failures.push(failure);
  };
  const before = await lintDocument(source, cfg, docRelPath, onPluginFailure);
  const fixed = fixDocument(source, cfg, docRelPath, onPluginFailure);
  return { cfg, before, fixed, ran, failures };
}

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

  const scopeRel = relative(contentDir, scopeDir ?? contentDir);
  if (scopeRel !== '' && filter.isDirExcluded(scopeRel)) return [];
  walk(scopeDir ?? contentDir);
  return docFiles;
}

export async function auditProject(
  opts: AuditOptions & { targetPath?: string },
): Promise<AuditResult> {
  const { projectDir, contentDir, baseConfig, targetPath, auditGeneration } = opts;
  const warnings: string[] = [];
  let ran: LintPluginId[] = [];
  const startGeneration = auditGeneration?.();

  const docFiles: string[] = [];
  let scanIncomplete = false;
  const scopeWarning = auditScopeWarning(
    opts.resolvedScope ?? { path: resolve(contentDir, targetPath ?? '') },
    contentDir,
    targetPath,
  );
  if (scopeWarning !== undefined) {
    warnings.push(scopeWarning);
    return { files: [], fileCount: 0, errorCount: 0, warningCount: 0, warnings, ran: [] };
  }
  const scope = opts.resolvedScope ?? resolveScope(targetPath, contentDir);
  if (scope.kind === 'file') {
    docFiles.push(relative(contentDir, scope.path));
  } else {
    docFiles.push(
      ...collectDocFiles({
        projectDir,
        contentDir,
        scopeDir: scope.path,
        onWarning: (warning) => {
          scanIncomplete = true;
          warnings.push(warning);
        },
      }),
    );
  }

  docFiles.sort();
  if (docFiles.length === 0 && !scanIncomplete) warnings.push(AUDIT_EMPTY_SCOPE_WARNING);

  const files: FileLintResult[] = [];
  const pluginFailures: LintPluginFailure[] = [];
  let errorCount = 0;
  let warningCount = 0;
  const seenConfigProblems = new Set<string>();
  const onConfigProblem = (problem: string) => {
    if (seenConfigProblems.has(problem)) return;
    seenConfigProblems.add(problem);
    warnings.push(problem);
  };
  const auditBase = composeFrontmatterSchemasConfig(projectDir, baseConfig, onConfigProblem);
  ran = deriveValidationRunSources(auditBase, { mode: 'lint' });
  const fmSlice = auditBase.plugins.frontmatter;
  if (scope.kind === 'dir' && relative(contentDir, scope.path) === '' && fmSlice.enabled) {
    for (const problem of unmatchedAppliesToProblems(fmSlice.schemas, docFiles)) {
      onConfigProblem(problem);
    }
  }
  let sliceStartedAt = performance.now();
  for (const rel of docFiles) {
    if (performance.now() - sliceStartedAt >= YIELD_SLICE_MS) {
      await yieldToEventLoop();
      if (auditGeneration !== undefined && auditGeneration() !== startGeneration) {
        throw new AuditSupersededError();
      }
      sliceStartedAt = performance.now();
    }
    let result: LintDocRunResult;
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
    pluginFailures.push(...result.failures);
    for (const d of result.diagnostics) {
      if (d.severity === 'error') errorCount++;
      else warningCount++;
    }
    if (result.diagnostics.length > 0) {
      files.push({ file: result.file, diagnostics: result.diagnostics });
    }
  }

  if (auditGeneration !== undefined && auditGeneration() !== startGeneration) {
    throw new AuditSupersededError();
  }

  warnings.push(...summarizeLintPluginFailures(pluginFailures));

  return { files, fileCount: docFiles.length, errorCount, warningCount, warnings, ran };
}

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

export function auditScopeWarning(
  scope: Pick<AuditScope, 'path'>,
  contentDir: string,
  targetPath: string | undefined,
): string | undefined {
  const scopeRel = relative(contentDir, scope.path);
  if (scopeRel.startsWith('..') || isAbsolute(scopeRel)) {
    return `refusing audit scope outside the content directory: ${targetPath ?? ''}`;
  }
  if (scopeRel.split('/').some((segment) => segment.startsWith('.'))) {
    return `refusing audit scope under a hidden path segment: ${targetPath ?? ''}`;
  }
  let canonicalContent: string;
  try {
    canonicalContent = realpathSync(contentDir);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined;
    }
    throw error;
  }
  let candidate = scope.path;
  for (;;) {
    try {
      if (!isWithinContentDir(realpathSync(candidate), canonicalContent)) {
        return 'symlink-escape: audit scope resolves outside the content directory';
      }
      return undefined;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)) throw error;
      if (error.code === 'ELOOP' || error.code === 'ENAMETOOLONG') return undefined;
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

export function resolveScope(targetPath: string | undefined, contentDir: string): AuditScope {
  const resolution = resolveAuditScope(targetPath, contentDir);
  return resolution.ok ? resolution.scope : { kind: 'dir', path: resolution.path };
}

function isDocFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
