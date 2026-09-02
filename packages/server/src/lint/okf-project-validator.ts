import { dirname, relative } from 'node:path';
import {
  deriveValidationRunSources,
  type LinterConfig,
  runOkfProjectRules,
} from '@inkeep/open-knowledge-core';
import { collectDocFiles, resolveScope } from './audit.ts';
import type {
  ProjectValidator,
  ValidationDiagnosticFor,
  ValidationScope,
} from './validation-audit.ts';

const FILE_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
} as const;

export interface OkfProjectValidatorDeps {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
}

export function createOkfProjectValidator(deps: OkfProjectValidatorDeps): ProjectValidator<'okf'> {
  const sourceFamilies = deriveValidationRunSources(deps.baseConfig, { mode: 'lint' }).filter(
    (source): source is 'okf' => source === 'okf',
  );
  return {
    id: 'okf-project',
    sourceFamilies,
    failureSourceFamily: 'okf',
    async run(scope: ValidationScope) {
      if (sourceFamilies.length === 0) {
        return { files: [], fileCount: 0, warnings: [] };
      }

      const warnings: string[] = [];
      const resolved = resolveScope(scope.targetPath, deps.contentDir);
      const targetFile =
        resolved.kind === 'file' ? relative(deps.contentDir, resolved.path) : undefined;
      const walkDir = resolved.kind === 'file' ? dirname(resolved.path) : resolved.path;
      const docFiles = collectDocFiles({
        projectDir: deps.projectDir,
        contentDir: deps.contentDir,
        scopeDir: walkDir,
        onWarning: (warning) => warnings.push(warning),
      });

      const byFile = new Map<string, ValidationDiagnosticFor<'okf'>[]>();
      for (const finding of runOkfProjectRules(docFiles, deps.baseConfig.plugins.okf?.rules)) {
        if (targetFile !== undefined && finding.file !== targetFile) continue;
        const diagnostics = byFile.get(finding.file) ?? [];
        diagnostics.push({
          range: FILE_RANGE,
          severity: 'warning',
          source: 'okf',
          code: finding.code,
          message: finding.message,
        });
        byFile.set(finding.file, diagnostics);
      }

      return {
        files: [...byFile.entries()].map(([file, diagnostics]) => ({ file, diagnostics })),
        fileCount: targetFile === undefined ? docFiles.length : 1,
        warnings,
      };
    },
  };
}
