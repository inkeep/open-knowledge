/**
 * `open-knowledge migrate notion [dir]` — normalize a raw Notion `Markdown & CSV`
 * export into clean Open Knowledge content, in place.
 *
 * Filesystem-only (no server): run it on the unzipped export before or instead
 * of `ok start`. Dry-run by default — it prints what it would change and writes
 * nothing until `--apply`. All transforms are idempotent.
 */

import { resolve } from 'node:path';
import { Command } from 'commander';
import { ALL_TRANSFORMS, applyPlan, buildPlan, type TransformId } from './migrate/notion/plan.ts';
import { formatReport, formatReportJson } from './migrate/notion/report.ts';

function parseTransformIds(csv: string): TransformId[] {
  const valid = new Set<string>(ALL_TRANSFORMS);
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (!valid.has(s)) {
        throw new Error(`Unknown transform "${s}". Valid transforms: ${ALL_TRANSFORMS.join(', ')}`);
      }
      return s as TransformId;
    });
}

function resolveSelected(only?: string, skip?: string): Set<TransformId> {
  let selected = new Set<TransformId>(ALL_TRANSFORMS);
  if (only) selected = new Set(parseTransformIds(only));
  if (skip) for (const id of parseTransformIds(skip)) selected.delete(id);
  return selected;
}

interface NotionOptions {
  apply?: boolean;
  stripBase64?: boolean;
  removeCsv?: boolean;
  only?: string;
  skip?: string;
  force?: boolean;
  json?: boolean;
}

export function migrateCommand(): Command {
  const migrate = new Command('migrate').description(
    'Migrate content from other tools into Open Knowledge',
  );

  migrate
    .command('notion [dir]')
    .description('Clean up a Notion "Markdown & CSV" export in place (dry-run unless --apply)')
    .option('--apply', 'write changes to disk (default: dry-run preview)')
    .option('--strip-base64', 'delete inline base64 images instead of extracting them to files')
    .option('--remove-csv', 'delete each "_all.csv" once its table page exists (destructive)')
    .option(
      '--only <transforms>',
      'run only these transforms (comma-separated: links,frontmatter,callouts,images,tables)',
    )
    .option('--skip <transforms>', 'skip these transforms (comma-separated)')
    .option('--force', 'run even if the directory is not detected as a Notion export')
    .option('--json', 'print a machine-readable JSON report')
    .action((dir: string | undefined, options: NotionOptions) => {
      const target = resolve(dir ?? process.cwd());

      let selected: Set<TransformId>;
      try {
        selected = resolveSelected(options.only, options.skip);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
        return;
      }

      const plan = buildPlan(target, {
        selected,
        stripBase64: options.stripBase64 ?? false,
        removeCsv: options.removeCsv ?? false,
        force: options.force ?? false,
      });
      const { report } = plan;

      // Refuse a directory that is not a Notion export (unless --force).
      if (!report.isNotionExport && !options.force) {
        if (options.json) {
          console.log(
            JSON.stringify({ refused: true, reason: 'not-a-notion-export', dir: target }, null, 2),
          );
        } else {
          console.error(
            `Not a Notion export: ${target}\n` +
              'No id-suffixed pages, "_all.csv", or inline base64 images were found. ' +
              'Re-run with --force to override.',
          );
        }
        process.exitCode = 2;
        return;
      }

      if (options.apply) {
        try {
          applyPlan(plan);
        } catch (err) {
          // An I/O failure (EACCES / ENOSPC / EPERM / …) mid-apply leaves a
          // partial export; report it clearly instead of a raw crash.
          console.error(
            `Failed to apply changes: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 4;
          return;
        }
      }

      console.log(
        options.json
          ? formatReportJson(report, { applied: options.apply ?? false })
          : formatReport(report, { applied: options.apply ?? false, dir: target }),
      );

      const nothingToDo =
        report.filesChanged === 0 && report.assetsExtracted === 0 && plan.deletions.length === 0;
      if (nothingToDo) {
        process.exitCode = 1;
      } else if (
        options.apply &&
        (report.ambiguousTitleLinks > 0 || report.wideTables.length > 0)
      ) {
        process.exitCode = 3;
      }
    });

  return migrate;
}
