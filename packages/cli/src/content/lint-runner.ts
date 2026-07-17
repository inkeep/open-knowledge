/**
 * Headless markdown linter — walks a content directory (or a sub-path), lints
 * every in-scope `.md`/`.mdx` document with the core engine, and optionally
 * applies fixes in place. The effective config is the project's `contentRules`
 * base with the native `.markdownlint.*` rules injected (same resolution the
 * server uses).
 */

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
  fixDocument,
  type LintDiagnostic,
  type LinterConfig,
  lintDocument,
  SUPPORTED_DOC_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import {
  composeEffectiveLinterConfig,
  createContentFilter,
  resolveNativeConfigForDoc,
} from '@inkeep/open-knowledge-server';

export interface FileLintResult {
  /** Path relative to `contentDir` (as produced by `node:path`). */
  file: string;
  diagnostics: LintDiagnostic[];
  /** True when `--fix` rewrote this file. */
  fixed: boolean;
}

export interface LintRunResult {
  contentDir: string;
  files: FileLintResult[];
  /** Non-fatal issues (unreadable dir/file, …). */
  warnings: string[];
  fileCount: number;
  errorCount: number;
  warningCount: number;
  fixedCount: number;
}

export interface RunLintOptions {
  projectDir: string;
  contentDir: string;
  /** The project-level content-rules config (from merged `config.contentRules`). */
  baseConfig: LinterConfig;
  /** Absolute path to a file or folder to scope the run to. Defaults to contentDir. */
  targetPath?: string;
  fix?: boolean;
}

export async function runLint(opts: RunLintOptions): Promise<LintRunResult> {
  const { projectDir, contentDir, baseConfig, targetPath, fix = false } = opts;

  const warnings: string[] = [];
  const filter = createContentFilter({ projectDir, contentDir });

  // markdownlint `rules` come from the project's native `.markdownlint.*`
  // files, resolved per doc with cli2 cascade semantics (nearest file on the
  // doc→root walk governs wholesale; OK's tuned defaults only when no file
  // governs) — the same resolution the server uses. Memoized per directory:
  // every doc in a folder shares one governing file.
  const cfgByDir = new Map<string, LinterConfig>();
  const seenConfigProblems = new Set<string>();
  const configForDoc = (rel: string): LinterConfig => {
    const dir = dirname(rel);
    const cached = cfgByDir.get(dir);
    if (cached) return cached;
    const native = resolveNativeConfigForDoc(contentDir, rel, (problem) => {
      if (seenConfigProblems.has(problem)) return;
      seenConfigProblems.add(problem);
      warnings.push(problem);
    });
    const cfg = composeEffectiveLinterConfig(baseConfig, native);
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
      // Hidden segments (.ok/, .git/, .obsidian/, dotfiles) are OK state, not
      // authored content — same skip the server audit applies. An explicitly
      // named hidden file (`ok lint .ok/foo.md`) still lints: the file-scope
      // branch above bypasses the walk, matching linter-CLI convention.
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
      const fixedText = fixDocument(text, cfg);
      if (fixedText !== text) {
        // tmp + rename so an interrupted write can never leave the document
        // half-written (mirrors the server's markdownlint-write pattern).
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
          } catch {
            // tmp may not exist if the write itself failed.
          }
          warnings.push(`could not write fix to ${rel}: ${errMsg(e)}`);
        }
      }
    }

    const diagnostics = await lintDocument(text, cfg, rel);
    for (const d of diagnostics) {
      if (d.severity === 'error') errorCount++;
      else warningCount++;
    }
    files.push({ file: rel, diagnostics, fixed: wasFixed });
  }

  return {
    contentDir,
    files,
    warnings,
    fileCount: docFiles.length,
    errorCount,
    warningCount,
    fixedCount,
  };
}

type Scope = { kind: 'dir' | 'file'; path: string };

/** Resolve the scope to an absolute file or directory under `contentDir`. */
function resolveScope(targetPath: string | undefined, contentDir: string): Scope {
  if (targetPath === undefined || targetPath === '') return { kind: 'dir', path: contentDir };
  const abs = isAbsolute(targetPath) ? targetPath : resolve(contentDir, targetPath);
  try {
    if (statSync(abs).isFile()) return { kind: 'file', path: abs };
  } catch {
    // Fall through — treat as a directory; the walk warns if it's unreadable.
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
