import type { Report, TransformId } from './plan.ts';

const LABELS: Record<TransformId, string> = {
  images: 'Inline base64 images extracted',
  callouts: 'Notion <aside> callouts converted',
  frontmatter: 'Row properties lifted to frontmatter',
  tables: 'Databases rendered as tables',
  links: 'Internal links decoded',
};

const ORDER: readonly TransformId[] = ['images', 'callouts', 'frontmatter', 'tables', 'links'];

/** Human-readable per-transform summary. */
export function formatReport(report: Report, o: { applied: boolean; dir: string }): string {
  const lines: string[] = [];
  lines.push(
    o.applied ? `Applied Notion cleanup in ${o.dir}` : `Dry run — no changes written (${o.dir})`,
  );
  for (const id of ORDER) {
    lines.push(`  ${LABELS[id]}: ${report.transforms[id]}`);
  }
  lines.push(`  Assets written: ${report.assetsExtracted}`);
  if (report.stubsCreated > 0) {
    lines.push(`  Database pages created (CSVs without a stub): ${report.stubsCreated}`);
  }
  if (report.csvsRemoved > 0) {
    lines.push(`  CSV files removed: ${report.csvsRemoved}`);
  }
  lines.push(`  Files changed: ${report.filesChanged}`);
  if (report.ambiguousTitleLinks > 0) {
    lines.push(`  Ambiguous title links left as plain text: ${report.ambiguousTitleLinks}`);
  }
  if (report.wideTables.length > 0) {
    lines.push(`  Wide tables (>15 columns): ${report.wideTables.length}`);
  }
  if (report.unreadable.length > 0) {
    lines.push(`  Skipped unreadable files: ${report.unreadable.length}`);
  }
  if (!o.applied && report.filesChanged + report.assetsExtracted + report.csvsRemoved > 0) {
    lines.push('');
    lines.push('Re-run with --apply to write these changes.');
  }
  return lines.join('\n');
}

/** Machine-readable report for `--json`. */
export function formatReportJson(report: Report, o: { applied: boolean }): string {
  return JSON.stringify({ applied: o.applied, ...report }, null, 2);
}
