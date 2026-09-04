import {
  countDiagnosticsBySource,
  DEFAULT_LINKS_VALIDATION,
  deriveValidationRunSources,
  type LinksValidationSetting,
  type LinterConfig,
  type LintPluginId,
  SUPPORTED_DOC_EXTENSIONS,
  type ValidationDiagnostic,
  type ValidationDocCounts,
  type ValidationSource,
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
  getLocalTargetAssessmentsForSources(
    sourceDocumentNames?: readonly string[],
  ): LocalTargetsResult | Promise<LocalTargetsResult>;
}

export type ValidationDiagnosticFor<Source extends ValidationSource> = Omit<
  ValidationDiagnostic,
  'source'
> & { source: Source };

interface FileValidationResult<Source extends ValidationSource = ValidationSource> {
  file: string;
  diagnostics: ValidationDiagnosticFor<Source>[];
}

export interface ValidationAuditResult {
  files: FileValidationResult[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  warnings: string[];
  ran: ValidationSource[];
}

export interface ValidationAuditCountsResult {
  files: ValidationDocCounts[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  warnings: string[];
}

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
  targetPath?: string;
}

interface ValidatorRunResult<Source extends ValidationSource = ValidationSource> {
  files: FileValidationResult<Source>[];
  fileCount: number;
  warnings: string[];
  ran?: readonly Source[];
}

export interface ProjectValidator<Source extends ValidationSource = ValidationSource> {
  readonly id: string;
  readonly sourceFamilies: readonly Source[];
  readonly failureSourceFamily?: Source;
  run(scope: ValidationScope): Promise<ValidatorRunResult<Source>>;
}

type ValidatorFailureAttribution =
  | { kind: 'validator'; id: string }
  | { kind: 'source-family'; sourceFamily: ValidationSource };

export function formatValidatorFailureWarning(
  attribution: ValidatorFailureAttribution,
  message: string,
): string {
  return attribution.kind === 'validator'
    ? `validator "${attribution.id}" failed: ${message}`
    : `source family "${attribution.sourceFamily}" validation failed: ${message}`;
}

export function formatValidatorDegradationWarning(
  sourceFamily: ValidationSource,
  message: string,
): string {
  return `source family "${sourceFamily}" validation degraded: ${message}`;
}

export interface ValidationAuditDeps {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
  liveSourceFor?: (docRelPath: string) => string | null;
  derivedDocumentIndex: ValidationDerivedIndexReader | null;
  linksValidation?: LinksValidationSetting;
  admittedDocNames: () => Iterable<string> | Promise<Iterable<string>>;
  docFilePathFor: (docName: string) => string | null;
  cache?: AuditCache;
  auditGeneration?: () => string;
}

export function createProjectValidators(deps: ValidationAuditDeps): ProjectValidator[] {
  return [createLintValidator(deps), createLinksValidator(deps), createOkfProjectValidator(deps)];
}

export async function runValidationAudit(
  validators: readonly ProjectValidator[],
  scope: ValidationScope = {},
): Promise<ValidationAuditResult> {
  const results = await Promise.all(
    validators.map(async (validator) => {
      const declared = validator.sourceFamilies;
      try {
        const result = await validator.run(scope);
        return { ...result, ran: result.ran ?? declared };
      } catch (error) {
        if (error instanceof AuditSupersededError) throw error;
        getLogger('validation-audit').error(
          { err: error, validatorId: validator.id },
          '[audit] validator threw; degrading to a plane warning',
        );
        const message = error instanceof Error ? error.message : String(error);
        const failureWarning = formatValidatorFailureWarning(
          validator.failureSourceFamily === undefined
            ? { kind: 'validator', id: validator.id }
            : { kind: 'source-family', sourceFamily: validator.failureSourceFamily },
          message,
        );
        return {
          files: [],
          fileCount: 0,
          warnings: [failureWarning],
          ran: declared,
        } satisfies ValidatorRunResult;
      }
    }),
  );

  const byFile = new Map<string, ValidationDiagnostic[]>();
  const warnings: string[] = [];
  const ran = new Set<ValidationSource>();
  let fileCount = 0;
  for (const result of results) {
    warnings.push(...result.warnings);
    for (const source of result.ran ?? []) ran.add(source);
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

  return { files, fileCount, errorCount, warningCount, warnings, ran: [...ran] };
}

function byPosition(a: ValidationDiagnostic, b: ValidationDiagnostic): number {
  return (
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character ||
    a.source.localeCompare(b.source) ||
    a.code.localeCompare(b.code)
  );
}

function createLintValidator(deps: ValidationAuditDeps): ProjectValidator<LintPluginId> {
  const sourceFamilies = deriveValidationRunSources(deps.baseConfig, { mode: 'lint' });
  return {
    id: 'lint',
    sourceFamilies,
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
      return {
        files: audit.files,
        fileCount: audit.fileCount,
        warnings: audit.warnings,
        ran: audit.ran,
      };
    },
  };
}

function createLinksValidator(deps: ValidationAuditDeps): ProjectValidator<'links'> {
  const setting = deps.linksValidation ?? DEFAULT_LINKS_VALIDATION;
  const sourceFamilies = deriveValidationRunSources(deps.baseConfig, {
    mode: 'audit',
    linksValidation: setting,
  }).filter((source): source is 'links' => source === 'links');
  return {
    id: 'links',
    sourceFamilies,
    failureSourceFamily: 'links',
    async run(scope) {
      if (setting === 'off') {
        return { files: [], fileCount: 0, warnings: [] };
      }
      const severity = setting === 'error' ? 'error' : 'warning';
      if (!deps.derivedDocumentIndex) {
        return {
          files: [],
          fileCount: 0,
          warnings: [
            formatValidatorFailureWarning(
              { kind: 'source-family', sourceFamily: 'links' },
              'backlink index is not configured',
            ),
          ],
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
      if (sourceFilter !== undefined && sourceFilter.length === 0) {
        assertCurrent();
        return { files: [], fileCount: 0, warnings: [] };
      }
      const deadLinks = await deps.derivedDocumentIndex.getDeadLinks(admitted, sourceFilter);

      const byFile = new Map<string, ValidationDiagnosticFor<'links'>[]>();
      const push = (file: string, diagnostic: ValidationDiagnosticFor<'links'>): void => {
        const diagnostics = byFile.get(file) ?? [];
        diagnostics.push(diagnostic);
        byFile.set(file, diagnostics);
      };

      const localTargetDiagnostics: Array<{
        file: string;
        diagnostic: ValidationDiagnosticFor<'links'>;
      }> = [];
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
        warnings.push(
          formatValidatorDegradationWarning(
            'links',
            `local-target projection unavailable: ${message}`,
          ),
        );
      }

      for (const { target, sources } of deadLinks) {
        for (const occurrence of sources) {
          if (isProblemsPlaneExcludedDoc(occurrence.source)) continue;
          const key = `${occurrence.source}\0${target}`;
          if (
            occurrence.sourceForm !== 'wiki' &&
            (documentTargetsFromAssessment.has(key) || resolvedTargetsFromAssessment.has(key))
          ) {
            continue;
          }
          const file = deps.docFilePathFor(occurrence.source) ?? `${occurrence.source}.md`;
          const line = occurrence.line ?? 0;
          const character = occurrence.column ?? 0;
          push(file, {
            range: { start: { line, character }, end: { line, character } },
            severity,
            source: 'links',
            code: 'dead-link',
            message: `Link target "${target}" does not resolve to an existing document.`,
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

function localTargetMessage(assessment: LocalTargetAssessment, shown: string): string {
  const isImage = assessment.occurrence.role === 'image';
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

function toLocalTargetDiagnostic(
  assessment: LocalTargetAssessment,
  severity: 'error' | 'warning',
): ValidationDiagnosticFor<'links'> | null {
  if (assessment.reason === null) return null;
  const { occurrence, targetKind } = assessment;

  const localTarget = buildLocalTargetEvidence(assessment, assessment.reason);
  if (localTarget === null) return null;

  const shown = assessment.resolvedTarget ?? occurrence.href;
  const line = occurrence.line;
  const character = occurrence.column;
  const diagnostic: ValidationDiagnosticFor<'links'> = {
    range: { start: { line, character }, end: { line, character } },
    severity,
    source: 'links',
    code: 'dead-link',
    message: localTargetMessage(assessment, shown),
    localTarget,
  };
  if (
    targetKind === 'document' &&
    assessment.status === 'missing' &&
    assessment.resolvedTarget !== null
  ) {
    diagnostic.linkTarget = assessment.resolvedTarget;
  }
  return diagnostic;
}

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
