import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
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
import {
  composeEffectiveLinterConfig,
  composeFrontmatterSchemasConfig,
  createContentFilter,
  resolveNativeConfigForDoc,
} from '@inkeep/open-knowledge-server';

interface FileLintResult {
  file: string;
  diagnostics: LintDiagnostic[];
  fixed: boolean;
}

export interface LintRunResult {
  contentDir: string;
  files: FileLintResult[];
  warnings: string[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  fixedCount: number;
  ran: LintPluginId[];
}

export interface RunLintOptions {
  projectDir: string;
  contentDir: string;
  baseConfig: LinterConfig;
  targetPath?: string;
  fix?: boolean;
}

export async function runLint(opts: RunLintOptions): Promise<LintRunResult> {
  const { projectDir, contentDir, baseConfig, targetPath, fix = false } = opts;

  const warnings: string[] = [];
  const filter = createContentFilter({ projectDir, contentDir });

  const seenConfigProblems = new Set<string>();
  const pushConfigProblem = (problem: string): void => {
    if (seenConfigProblems.has(problem)) return;
    seenConfigProblems.add(problem);
    warnings.push(problem);
  };

  const resolvedBase = composeFrontmatterSchemasConfig(projectDir, baseConfig, pushConfigProblem);
  const ran = deriveValidationRunSources(resolvedBase, { mode: 'lint' });
  const pluginFailures: LintPluginFailure[] = [];
  const pushPluginFailure = (failure: LintPluginFailure): void => {
    pluginFailures.push(failure);
  };

  const cfgByDir = new Map<string, LinterConfig>();
  const configForDoc = (rel: string): LinterConfig => {
    const dir = dirname(rel);
    const cached = cfgByDir.get(dir);
    if (cached) return cached;
    const native = resolveNativeConfigForDoc(contentDir, rel, pushConfigProblem);
    const cfg = composeEffectiveLinterConfig(resolvedBase, native);
    cfgByDir.set(dir, cfg);
    return cfg;
  };

  const docFiles: string[] = [];
  const scope = resolveScope(targetPath, contentDir);
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
      warnings.push(
        `could not read directory ${relative(contentDir, absDir) || '.'}: ${errMsg(e)}`,
      );
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

  docFiles.sort();

  const files: FileLintResult[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let fixedCount = 0;

  for (const rel of docFiles) {
    const abs = join(contentDir, rel);
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch (e) {
      warnings.push(`could not read ${rel}: ${errMsg(e)}`);
      continue;
    }

    const cfg = configForDoc(rel);
    let wasFixed = false;
    if (fix && cfg.enabled) {
      const fixedText = fixDocument(text, cfg, rel, pushPluginFailure);
      if (fixedText !== text) {
        const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
        try {
          writeFileSync(tmp, fixedText, 'utf-8');
          renameSync(tmp, abs);
          text = fixedText;
          wasFixed = true;
          fixedCount++;
        } catch (e) {
          try {
            unlinkSync(tmp);
          } catch {}
          warnings.push(`could not write fix to ${rel}: ${errMsg(e)}`);
        }
      }
    }

    const diagnostics = await lintDocument(text, cfg, rel, pushPluginFailure);
    for (const d of diagnostics) {
      if (d.severity === 'error') errorCount++;
      else warningCount++;
    }
    files.push({ file: rel, diagnostics, fixed: wasFixed });
  }

  warnings.push(...summarizeLintPluginFailures(pluginFailures));

  return {
    contentDir,
    files,
    warnings,
    fileCount: docFiles.length,
    errorCount,
    warningCount,
    fixedCount,
    ran,
  };
}

type Scope = { kind: 'dir' | 'file'; path: string };

function resolveScope(targetPath: string | undefined, contentDir: string): Scope {
  if (targetPath === undefined || targetPath === '') return { kind: 'dir', path: contentDir };
  const abs = isAbsolute(targetPath) ? targetPath : resolve(contentDir, targetPath);
  try {
    if (statSync(abs).isFile()) return { kind: 'file', path: abs };
  } catch {}
  return { kind: 'dir', path: abs };
}

function isDocFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
