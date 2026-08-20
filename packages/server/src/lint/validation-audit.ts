/**
 * Unified validation audit: a project-validator registry one level above the
 * lint-plugin registry (`LINT_PLUGINS`, untouched). Each validator answers
 * "given the project (or a sub-path), what per-file diagnostics hold?" behind
 * one interface while owning its own execution model — the lint validator
 * walks the content tree via `auditProject`; the links validator reads the
 * derived document index; the OKF project validator walks for the file LIST
 * and judges it as a whole, reading no document. The engine fans out and merges
 * everything into one source-tagged diagnostic plane. Backs `GET /api/audit` +
 * MCP `audit`.
 */

import {
  countDiagnosticsBySource,
  DEFAULT_LINKS_VALIDATION,
  type LinksValidationSetting,
  type LinterConfig,
  SUPPORTED_DOC_EXTENSIONS,
  type ValidationDiagnostic,
  type ValidationDocCounts,
} from '@inkeep/open-knowledge-core';
import { isProblemsPlaneExcludedDoc } from '../cc1-broadcast.ts';
import type { DerivedDocumentIndexApiPort } from '../derived-document-index.ts';
import {
  buildLocalTargetEvidence,
  type LocalTargetAssessment,
} from '../local-target-assessment.ts';
import { getLogger } from '../logger.ts';
import { AuditSupersededError, auditProject } from './audit.ts';
import type { AuditCache } from './audit-cache.ts';
import { createOkfProjectValidator } from './okf-project-validator.ts';

type DeadLinksResult = Awaited<ReturnType<DerivedDocumentIndexApiPort['getDeadLinks']>>;
type LocalTargetsResult = Awaited<
  ReturnType<DerivedDocumentIndexApiPort['getLocalTargetAssessmentsForSources']>
>;

interface ValidationDerivedIndexReader {
  getDeadLinks(
    admittedDocuments: Iterable<string>,
    sourceDocumentNames?: readonly string[],
  ): DeadLinksResult | Promise<DeadLinksResult>;
  /**
   * Assessed local-target occurrences per source (all sources, or a scoped set).
   * The links validator projects the unresolved ones — files, images, and
   * reference-style targets — into the same plane as graph dead-links.
   */
  getLocalTargetAssessmentsForSources(
    sourceDocumentNames?: readonly string[],
  ): LocalTargetsResult | Promise<LocalTargetsResult>;
}

interface FileValidationResult {
  /** Path relative to `contentDir`. */
  file: string;
  diagnostics: ValidationDiagnostic[];
}

export interface ValidationAuditResult {
  files: FileValidationResult[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  warnings: string[];
}

export interface ValidationAuditCountsResult {
  files: ValidationDocCounts[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  warnings: string[];
}

/**
 * Tally an audit result into the counts-only plane. A derivation of the
 * enumerated plane, never a second determination — same walk, same predicate
 * (`countDiagnosticsBySource`), only the diagnostic bodies dropped. Callers
 * that keep file-tree tints fresh want the tallies and would discard the
 * bodies immediately; on a large KB those bodies are tens of MB per request.
 */
export function toValidationCountsPlane(
  result: ValidationAuditResult,
): ValidationAuditCountsResult {
  return {
    files: result.files.map((entry) => ({
      file: entry.file,
      ...countDiagnosticsBySource(entry.diagnostics),
    })),
    fileCount: result.fileCount,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    warnings: result.warnings,
  };
}

export interface ValidationScope {
  /** contentDir-relative folder or doc-file path; absent audits the whole project. */
  targetPath?: string;
}

interface ValidatorRunResult {
  files: FileValidationResult[];
  /**
   * In-scope docs this validator scanned as a full-scan authority; 0 when it
   * reads an index instead of walking. The engine keeps the max across
   * validators as the plane's `fileCount`.
   */
  fileCount: number;
  warnings: string[];
}

export interface ProjectValidator {
  readonly id: string;
  run(scope: ValidationScope): Promise<ValidatorRunResult>;
}

export interface ValidationAuditDeps {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
  /** Live CRDT source overlay for loaded docs (see `AuditOptions.liveSourceFor`). */
  liveSourceFor?: (docRelPath: string) => string | null;
  /** Null when the server booted without a derived index; links findings degrade to a warning. */
  derivedDocumentIndex: ValidationDerivedIndexReader | null;
  /**
   * Project posture for broken links (`validation.links`): 'off' silences the
   * links validator entirely, 'warning' (default) / 'error' set the severity.
   */
  linksValidation?: LinksValidationSetting;
  /** Every docName that currently exists — the dead-link existence oracle. */
  admittedDocNames: () => Iterable<string> | Promise<Iterable<string>>;
  /** docName → on-disk contentDir-relative path, null when no file exists yet. */
  docFilePathFor: (docName: string) => string | null;
  /** Shared across audits so an unchanged-config re-walk does no lint work. */
  cache?: AuditCache;
  /** Lint config + active branch, as one equality token (see `AuditOptions.auditGeneration`). */
  auditGeneration?: () => string;
}

/**
 * The registered project validators. Admitting a new validator means appending
 * one factory here — the engine body never changes.
 */
export function createProjectValidators(deps: ValidationAuditDeps): ProjectValidator[] {
  return [createLintValidator(deps), createLinksValidator(deps), createOkfProjectValidator(deps)];
}

/** Fan out to every validator, then merge into one per-file diagnostic plane. */
export async function runValidationAudit(
  validators: readonly ProjectValidator[],
  scope: ValidationScope = {},
): Promise<ValidationAuditResult> {
  // Isolate validators: a throw degrades to a warning in the shared plane
  // instead of collapsing the whole audit (and discarding the validators that
  // succeeded) into an opaque 500. Extends the links validator's existing
  // null-index -> warning degradation to any unexpected throw, including from a
  // future validator.
  const results = await Promise.all(
    validators.map(async (validator) => {
      try {
        return await validator.run(scope);
      } catch (error) {
        // Supersession is not a validator failure — it invalidates the WHOLE
        // plane, so degrading it to a warning would publish the surviving
        // validators' findings as if they were a complete answer.
        if (error instanceof AuditSupersededError) throw error;
        // The plane's warning carries only `.message`; the stack goes to the
        // server log or a deep validator throw is undebuggable in production.
        getLogger('validation-audit').error(
          { err: error, validatorId: validator.id },
          '[audit] validator threw; degrading to a plane warning',
        );
        const message = error instanceof Error ? error.message : String(error);
        return {
          files: [],
          fileCount: 0,
          warnings: [`validator "${validator.id}" failed: ${message}`],
        } satisfies ValidatorRunResult;
      }
    }),
  );

  const byFile = new Map<string, ValidationDiagnostic[]>();
  const warnings: string[] = [];
  let fileCount = 0;
  for (const result of results) {
    warnings.push(...result.warnings);
    fileCount = Math.max(fileCount, result.fileCount);
    for (const entry of result.files) {
      const merged = byFile.get(entry.file);
      if (merged) merged.push(...entry.diagnostics);
      else byFile.set(entry.file, [...entry.diagnostics]);
    }
  }

  const files = [...byFile.entries()]
    .map(([file, diagnostics]) => ({ file, diagnostics: diagnostics.sort(byPosition) }))
    .sort((a, b) => a.file.localeCompare(b.file));

  let errorCount = 0;
  let warningCount = 0;
  for (const entry of files) {
    for (const diagnostic of entry.diagnostics) {
      if (diagnostic.severity === 'error') errorCount++;
      else warningCount++;
    }
  }

  return { files, fileCount, errorCount, warningCount, warnings };
}

function byPosition(a: ValidationDiagnostic, b: ValidationDiagnostic): number {
  return (
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character ||
    a.source.localeCompare(b.source) ||
    a.code.localeCompare(b.code)
  );
}

function createLintValidator(deps: ValidationAuditDeps): ProjectValidator {
  return {
    id: 'lint',
    async run(scope) {
      const audit = await auditProject({
        projectDir: deps.projectDir,
        contentDir: deps.contentDir,
        baseConfig: deps.baseConfig,
        targetPath: scope.targetPath,
        liveSourceFor: deps.liveSourceFor,
        cache: deps.cache,
        auditGeneration: deps.auditGeneration,
      });
      return { files: audit.files, fileCount: audit.fileCount, warnings: audit.warnings };
    },
  };
}

function createLinksValidator(deps: ValidationAuditDeps): ProjectValidator {
  const setting = deps.linksValidation ?? DEFAULT_LINKS_VALIDATION;
  return {
    id: 'links',
    async run(scope) {
      // 'off' is a clean empty contribution, not a degradation warning — the
      // project chose to silence link validation.
      if (setting === 'off') {
        return { files: [], fileCount: 0, warnings: [] };
      }
      const severity = setting === 'error' ? 'error' : 'warning';
      if (!deps.derivedDocumentIndex) {
        return {
          files: [],
          fileCount: 0,
          warnings: ['links validation unavailable: backlink index is not configured'],
        };
      }
      const startGeneration = deps.auditGeneration?.();
      const assertCurrent = (): void => {
        if (deps.auditGeneration !== undefined && deps.auditGeneration() !== startGeneration) {
          throw new AuditSupersededError();
        }
      };
      const admitted = [...(await deps.admittedDocNames())];
      const sourceFilter = scopedSourceDocNames(admitted, scope.targetPath);
      // `getDeadLinks` reads an empty source filter as "no filter" — a scope
      // matching zero docs must short-circuit here or it would silently widen
      // back to the whole project.
      if (sourceFilter !== undefined && sourceFilter.length === 0) {
        assertCurrent();
        return { files: [], fileCount: 0, warnings: [] };
      }
      const deadLinks = await deps.derivedDocumentIndex.getDeadLinks(admitted, sourceFilter);

      const byFile = new Map<string, ValidationDiagnostic[]>();
      const push = (file: string, diagnostic: ValidationDiagnostic): void => {
        const diagnostics = byFile.get(file) ?? [];
        diagnostics.push(diagnostic);
        byFile.set(file, diagnostics);
      };

      // The canonical classification comes from the assessment plane, so it is
      // computed FIRST and the graph plane fills only what it does not cover.
      // Both planes see the same occurrence; whichever reports it must be the
      // one every consumer reads, and the assessment row is a strict superset —
      // same message, plus the `localTarget` evidence (definition pointer,
      // resolution method, fallback target) and the same create-page
      // `linkTarget`. Reconciling by source form, as this once did, is a
      // hand-maintained rule that drifts the moment either plane learns a form.
      const localTargetDiagnostics: Array<{ file: string; diagnostic: ValidationDiagnostic }> = [];
      const documentTargetsFromAssessment = new Set<string>();
      const resolvedTargetsFromAssessment = new Set<string>();
      const warnings: string[] = [];
      try {
        const assessed =
          await deps.derivedDocumentIndex.getLocalTargetAssessmentsForSources(sourceFilter);
        for (const { source, assessments } of assessed) {
          if (isProblemsPlaneExcludedDoc(source)) continue;
          const file = deps.docFilePathFor(source) ?? `${source}.md`;
          for (const assessment of assessments) {
            const diagnostic = toLocalTargetDiagnostic(assessment, severity);
            if (!diagnostic) continue;
            localTargetDiagnostics.push({ file, diagnostic });
            if (assessment.targetKind === 'document' && assessment.resolvedTarget !== null) {
              documentTargetsFromAssessment.add(`${source}\0${assessment.resolvedTarget}`);
            }
          }
          // A target the canonical classifier proved EXISTS is not a dead link,
          // whatever the graph concluded. `assets/NOTICE` is the case: an
          // extension-less href naming a real ordinary file, which the graph
          // reads as a document. Suppressing here keeps Problems correct even
          // if the graph was built before the file inventory had seeded.
          for (const assessment of assessments) {
            if (assessment.status === 'exact' && assessment.resolvedTarget !== null) {
              resolvedTargetsFromAssessment.add(`${source}\0${assessment.resolvedTarget}`);
            }
          }
        }
      } catch (error) {
        if (error instanceof AuditSupersededError) throw error;
        getLogger('validation-audit').warn(
          { err: error },
          '[audit] local-target projection unavailable; preserving graph link findings',
        );
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`local-target validation unavailable: ${message}`);
      }

      for (const { target, sources } of deadLinks) {
        for (const occurrence of sources) {
          if (isProblemsPlaneExcludedDoc(occurrence.source)) continue;
          const key = `${occurrence.source}\0${target}`;
          // Already reported with richer evidence by the canonical classifier,
          // or proven by it to exist and therefore not a dead link at all.
          if (
            occurrence.sourceForm !== 'wiki' &&
            (documentTargetsFromAssessment.has(key) || resolvedTargetsFromAssessment.has(key))
          ) {
            continue;
          }
          // A source indexed from a live CRDT doc may not be on disk yet — fall
          // back to the default extension so the finding still names a file.
          const file = deps.docFilePathFor(occurrence.source) ?? `${occurrence.source}.md`;
          // Entries deserialized from a pre-position cache carry no position;
          // degrade to the start of the doc rather than dropping the finding.
          const line = occurrence.line ?? 0;
          const character = occurrence.column ?? 0;
          push(file, {
            range: { start: { line, character }, end: { line, character } },
            severity,
            source: 'links',
            code: 'dead-link',
            message: `Link target "${target}" does not resolve to an existing document.`,
            // The unresolved target, verbatim, so the Problems panel's
            // create-the-missing-page affordance never parses the message.
            linkTarget: target,
          });
        }
      }

      for (const { file, diagnostic } of localTargetDiagnostics) push(file, diagnostic);

      assertCurrent();

      return {
        files: [...byFile.entries()].map(([file, diagnostics]) => ({ file, diagnostics })),
        fileCount: 0,
        warnings,
      };
    },
  };
}

/** Human-readable message for a local-target finding, by reason, kind, and role. */
function localTargetMessage(assessment: LocalTargetAssessment, shown: string): string {
  const isImage = assessment.occurrence.role === 'image';
  // An unresolvable target never resolved to any identity (root escape, empty,
  // unsupported form) — distinct wording from a resolved-but-absent target. A
  // 'unknown' kind only ever arrives with this reason.
  if (assessment.reason === 'unresolvable') {
    return isImage
      ? `Image target "${shown}" could not be resolved to a project-local file.`
      : `Link target "${shown}" could not be resolved to a project-local target.`;
  }
  if (assessment.targetKind === 'file') {
    return isImage
      ? `Image target "${shown}" does not resolve to an existing file.`
      : `Link target "${shown}" does not resolve to an existing file.`;
  }
  return `Link target "${shown}" does not resolve to an existing document.`;
}

/**
 * Project one local-target assessment onto a validation diagnostic, or null when
 * it is not a finding. Exact targets are dropped (not a problem), and so are
 * forms with no local-target wire spelling — `buildLocalTargetEvidence` owns
 * that decision.
 *
 * Cross-plane de-duplication is NOT decided here. The caller runs this plane
 * first and suppresses the graph plane for any document target it already
 * reported, so one occurrence yields one finding without either plane guessing
 * at the other's coverage.
 */
function toLocalTargetDiagnostic(
  assessment: LocalTargetAssessment,
  severity: 'error' | 'warning',
): ValidationDiagnostic | null {
  // `reason` is null exactly when the target is `exact`, so this both drops
  // resolved targets and narrows `reason` to a concrete failure below.
  if (assessment.reason === null) return null;
  const { occurrence, targetKind } = assessment;

  // Wiki forms are classified but do not project onto the local-target wire
  // surfaces: a wiki document link is a graph edge, and a file-shaped wiki embed
  // resolves by vault-wide basename under its own contract.
  // `buildLocalTargetEvidence` owns that decision, so reading its null is the
  // single check rather than a second form predicate here that could drift.
  const localTarget = buildLocalTargetEvidence(assessment, assessment.reason);
  if (localTarget === null) return null;

  const shown = assessment.resolvedTarget ?? occurrence.href;
  const line = occurrence.line;
  const character = occurrence.column;
  const diagnostic: ValidationDiagnostic = {
    range: { start: { line, character }, end: { line, character } },
    severity,
    source: 'links',
    code: 'dead-link',
    message: localTargetMessage(assessment, shown),
    localTarget,
  };
  // Create page is document-only: only a missing document carries `linkTarget`,
  // and a document target always has a resolved docName. Files, images, and
  // unresolvable targets never offer it.
  if (
    targetKind === 'document' &&
    assessment.status === 'missing' &&
    assessment.resolvedTarget !== null
  ) {
    diagnostic.linkTarget = assessment.resolvedTarget;
  }
  return diagnostic;
}

/**
 * Translate a path scope into the dead-link source filter: a doc-file path
 * narrows to that one doc, anything else is a folder prefix over the admitted
 * set. This parallels the lint walk's scope intent but classifies by suffix
 * over the in-memory admitted set, not the on-disk `statSync` `resolveScope`
 * uses — so an admitted-but-unpersisted doc can scope differently across the
 * two validators. The filter is always a subset of the admitted set, so doc
 * scope stays a provable restriction of the project-wide dead-link predicate.
 */
function scopedSourceDocNames(
  admitted: readonly string[],
  targetPath: string | undefined,
): string[] | undefined {
  if (targetPath === undefined || targetPath === '') return undefined;
  const lower = targetPath.toLowerCase();
  if (SUPPORTED_DOC_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    const docName = targetPath.slice(0, targetPath.lastIndexOf('.'));
    return admitted.filter((name) => name === docName);
  }
  const prefix = `${targetPath.replace(/\/+$/, '')}/`;
  return admitted.filter((name) => name.startsWith(prefix));
}
