/**
 * Content scope preview — enumerates the files the watcher will index, given
 * a config snapshot, without spinning up the server.
 *
 * `previewContent()` is the load-bearing helper: it builds a `ContentFilter`
 * from `@inkeep/open-knowledge-server` and walks `contentDir` mirroring the
 * file-watcher's startup walk (`file-watcher.ts:seedLastKnownHashes`). Reusing
 * the same filter is the invariant that keeps the preview's count matching
 * what the watcher will actually index, including nested `.gitignore` +
 * `.okignore` handling (so `.ok/cache/` is excluded automatically).
 *
 * Returns warnings rather than throwing — preview failure must never block
 * init. `formatPreviewBlock()` renders the result for both the `init`
 * post-scaffold output and the standalone `open-knowledge preview` verb;
 * keeping the formatter here ensures both surfaces stay byte-identical.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createContentFilter } from '@inkeep/open-knowledge-server';
import { OK_DIR } from '../constants.ts';

interface PreviewOptions {
  projectDir: string;
  contentDir: string;
  sampleCap?: number;
}

export interface PreviewResult {
  totalCount: number;
  sample: string[];
  contentDir: string;
  warnings: string[];
}

const DEFAULT_SAMPLE_CAP = 5;

export function previewContent(opts: PreviewOptions): PreviewResult {
  const { projectDir, contentDir, sampleCap = DEFAULT_SAMPLE_CAP } = opts;
  const warnings: string[] = [];
  const files: string[] = [];

  try {
    lstatSync(contentDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      totalCount: 0,
      sample: [],
      contentDir,
      warnings: [`cannot access content directory ${contentDir}: ${msg}`],
    };
  }

  let filter: ReturnType<typeof createContentFilter>;
  try {
    filter = createContentFilter({
      projectDir,
      contentDir,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      totalCount: 0,
      sample: [],
      contentDir,
      warnings: [msg],
    };
  }

  function walk(dir: string): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`could not read directory ${relative(contentDir, dir) || '.'}: ${msg}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let canonical: string;
        try {
          canonical = realpathSync(fullPath);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ELOOP') {
            warnings.push(`broken or cyclic symlink: ${relative(contentDir, fullPath)}`);
          } else {
            warnings.push(
              `cannot resolve symlink ${relative(contentDir, fullPath)}: ${code ?? 'unknown error'}`,
            );
          }
          continue;
        }
        let resolved: ReturnType<typeof statSync>;
        try {
          resolved = statSync(canonical);
        } catch {
          continue;
        }
        if (resolved.isDirectory()) {
          const relPath = relative(contentDir, fullPath);
          if (filter.isDirExcluded(relPath)) continue;
          walk(fullPath);
        } else if (resolved.isFile()) {
          const relPath = relative(contentDir, fullPath);
          if (filter.isExcluded(relPath)) continue;
          files.push(relPath);
        }
      } else if (entry.isDirectory()) {
        const relPath = relative(contentDir, fullPath);
        if (filter.isDirExcluded(relPath)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = relative(contentDir, fullPath);
        if (filter.isExcluded(relPath)) continue;
        files.push(relPath);
      }
    }
  }

  walk(contentDir);

  return {
    totalCount: files.length,
    sample: files.slice(0, sampleCap),
    contentDir,
    warnings,
  };
}

export function formatPreviewBlock(result: PreviewResult, cwd: string): string {
  const lines: string[] = [];
  const rel = relative(cwd, result.contentDir);
  const displayDir = rel === '' ? './' : `./${rel}`;

  lines.push('Content:');
  lines.push(`  Found ${result.totalCount} markdown files in ${displayDir}`);

  if (result.sample.length > 0) {
    const sampleStr = result.sample.join(', ');
    const suffix = result.totalCount > result.sample.length ? ', \u2026' : '';
    lines.push(`  Sample: ${sampleStr}${suffix}`);
  }

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      lines.push(`  Warning: ${w}`);
    }
  }

  lines.push('');
  const configPath = join(cwd, OK_DIR, 'config.yml');
  if (existsSync(configPath)) {
    lines.push('  To adjust scope, add patterns to .okignore at the project root.');
    lines.push(`  To change the content root, edit ${OK_DIR}/config.yml → content.dir.`);
  } else {
    lines.push('  Run `open-knowledge init` to scaffold config + .okignore.');
  }

  lines.push('');
  lines.push('  Re-check anytime: open-knowledge preview');

  return lines.join('\n');
}
