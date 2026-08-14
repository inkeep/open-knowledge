/**
 * The OKF project validator: the checks that need the shape of the tree.
 *
 * A third execution model alongside the lint validator (walks and lints each document)
 * and the links validator (reads an in-memory index): this one walks for the file LIST
 * only, never reading a document's contents, then judges the list as a whole. The editor
 * lints by an extension-less docName, so only the walked list shows which files are
 * `.mdx` — that is what keeps this rule out of the `okf` lint plugin. It still reports
 * under the same `okf` source and the same `contentRules.okf.rules` toggles, so a reader
 * sees one coherent family.
 *
 * The rule bodies are pure and live in core; this file owns only the thing core cannot
 * do — walking the tree.
 */

import { dirname, relative } from 'node:path';
import {
  type LinterConfig,
  runOkfProjectRules,
  type ValidationDiagnostic,
} from '@inkeep/open-knowledge-core';
import { collectDocFiles, resolveScope } from './audit.ts';
import type { ProjectValidator, ValidationScope } from './validation-audit.ts';

/**
 * Zero-width anchor at the top of the file. A project finding is about the file's
 * existence or its name, not a region inside it, and this validator walks the file
 * LIST without reading any document's text — so there is no line whose length could
 * size a span. The finding attaches to the file (Problems panel, `ok audit`); the
 * range only places its editor marker at the start.
 */
const FILE_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
} as const;

export interface OkfProjectValidatorDeps {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
}

export function createOkfProjectValidator(deps: OkfProjectValidatorDeps): ProjectValidator {
  return {
    id: 'okf-project',
    async run(scope: ValidationScope) {
      const slice = deps.baseConfig.plugins.okf;
      // Plugin off is a clean empty contribution, not a degradation warning — the
      // project chose not to run OKF at all.
      if (!deps.baseConfig.enabled || !slice?.enabled) {
        return { files: [], fileCount: 0, warnings: [] };
      }

      const warnings: string[] = [];
      // Classify the target the way the lint walk does. A doc-scoped audit — what the
      // Problems panel issues for the open document — targets a FILE, and handing a file
      // path to the walk as a directory makes `readdir` throw and this validator report
      // nothing at all.
      //
      // A file target still walks its DIRECTORY rather than standing alone, then keeps
      // only that file's findings. The rule needs its siblings to know whether an `.mdx`
      // is shadowed by a same-stem `.md`, and a lone-file list would silently downgrade
      // every shadowed file to the unshadowed message.
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

      const byFile = new Map<string, ValidationDiagnostic[]>();
      for (const finding of runOkfProjectRules(docFiles, slice.rules)) {
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
        // Unlike the links validator this one really walked the tree, so it is a
        // full-scan authority for the scope it was given.
        fileCount: targetFile === undefined ? docFiles.length : 1,
        warnings,
      };
    },
  };
}
