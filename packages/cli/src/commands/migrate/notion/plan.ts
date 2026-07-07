/**
 * Planner + applier for `ok migrate notion`.
 *
 * `buildPlan` reads the export and computes every change WITHOUT writing (this is
 * what the dry-run prints). `applyPlan` performs the writes and deletions.
 * Per-file transforms run images -> callouts -> frontmatter -> links; the link
 * pass goes last so it sees the content the other transforms produced. Databases
 * are handled in a dedicated pass so every database gets a table page even when
 * Notion exported no stub for it. Everything is filesystem-only and idempotent.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { asideToCallout } from './aside-callout.ts';
import { extractBase64Images } from './base64-images.ts';
import { type DatabaseInfo, detectDatabases } from './databases.ts';
import { decodeLinks } from './decode-links.ts';
import { isNotionExport } from './detect.ts';
import { walkFiles } from './fs-walk.ts';
import { resolveKey } from './normalized-index.ts';
import { propertiesToFrontmatter } from './properties-frontmatter.ts';
import { buildStubPage, extractStubTitle, renderCsvTable } from './tables.ts';

export type TransformId = 'links' | 'frontmatter' | 'callouts' | 'images' | 'tables';

export const ALL_TRANSFORMS: readonly TransformId[] = [
  'links',
  'frontmatter',
  'callouts',
  'images',
  'tables',
];

export interface Report {
  isNotionExport: boolean;
  transforms: Record<TransformId, number>;
  assetsExtracted: number;
  /** New database pages created for CSVs that had no stub. */
  stubsCreated: number;
  /** `_all.csv` files scheduled for deletion (only with removeCsv). */
  csvsRemoved: number;
  wideTables: string[];
  ambiguousTitleLinks: number;
  /** Files skipped because they could not be read (deleted mid-run, EACCES, …). */
  unreadable: string[];
  filesChanged: number;
}

export interface Plan {
  changes: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; bytes: Uint8Array }>;
  deletions: string[];
  report: Report;
}

export interface PlanOptions {
  selected?: ReadonlySet<TransformId>;
  stripBase64?: boolean;
  /** Delete each `_all.csv` once its table page exists (destructive). */
  removeCsv?: boolean;
  force?: boolean;
}

const MD = /\.mdx?$/i;

function emptyReport(isNotionExport: boolean): Report {
  return {
    isNotionExport,
    transforms: { links: 0, frontmatter: 0, callouts: 0, images: 0, tables: 0 },
    assetsExtracted: 0,
    stubsCreated: 0,
    csvsRemoved: 0,
    wideTables: [],
    ambiguousTitleLinks: 0,
    unreadable: [],
    filesChanged: 0,
  };
}

export function buildPlan(dir: string, opts: PlanOptions = {}): Plan {
  const selected = opts.selected ?? new Set(ALL_TRANSFORMS);
  const notion = isNotionExport(dir);
  if (!notion && !opts.force) {
    return { changes: [], assets: [], deletions: [], report: emptyReport(false) };
  }

  const report = emptyReport(notion);
  const files = walkFiles(dir);
  const databases = detectDatabases(files, {
    onUnreadable: (path) => report.unreadable.push(path),
  });
  const doTables = selected.has('tables');

  const dbByRowFile = new Map<string, DatabaseInfo>();
  const existingStubs = new Set<string>();
  for (const db of databases) {
    if (db.stubPath) existingStubs.add(db.stubPath);
    for (const rf of db.rowFiles) dbByRowFile.set(rf, db);
  }

  const changes: Plan['changes'] = [];
  const assets: Plan['assets'] = [];
  const deletions: string[] = [];

  // --- Per-file transforms (images, callouts, frontmatter, links) ---
  for (const file of files) {
    if (!MD.test(file)) continue;
    // Existing database stubs are (re)generated in the database pass below.
    if (doTables && existingStubs.has(file)) continue;

    let original: string;
    try {
      original = readFileSync(file, 'utf8');
    } catch {
      // Deleted or unreadable since the walk (TOCTOU) — skip, don't crash the run.
      report.unreadable.push(file);
      continue;
    }
    let content = original;
    const bump = (id: TransformId, before: string) => {
      if (content !== before) report.transforms[id] += 1;
    };

    if (selected.has('images')) {
      const before = content;
      const res = extractBase64Images(content, basename(file), { strip: opts.stripBase64 });
      content = res.markdown;
      for (const a of res.assets)
        assets.push({ path: join(dirname(file), a.filename), bytes: a.bytes });
      report.assetsExtracted += res.assets.length;
      bump('images', before);
    }

    if (selected.has('callouts')) {
      const before = content;
      content = asideToCallout(content);
      bump('callouts', before);
    }

    if (selected.has('frontmatter')) {
      const db = dbByRowFile.get(file);
      if (db) {
        const before = content;
        content = propertiesToFrontmatter(content, db.propertyKeys);
        bump('frontmatter', before);
      }
    }

    if (selected.has('links')) {
      const before = content;
      content = decodeLinks(content, { redirectCsv: doTables });
      bump('links', before);
    }

    if (content !== original) changes.push({ path: file, content });
  }

  // --- Database pass: every database gets a table page ---
  if (doTables) {
    for (const db of databases) {
      const rendered = renderCsvTable(db.csvText, {
        linkForTitle: (title) => {
          const res = resolveKey(db.folderIndex, title);
          if (res.ambiguous) report.ambiguousTitleLinks += 1;
          return res.path ? relative(dirname(db.stubTargetPath), res.path) : null;
        },
      });
      if (rendered.columns === 0) continue; // empty/unreadable CSV — leave it alone

      const writePath = db.stubPath ?? db.stubTargetPath;
      let existing: string | null = null;
      if (db.stubPath) {
        try {
          existing = readFileSync(db.stubPath, 'utf8');
        } catch {
          // Never overwrite a stub we couldn't read — skip this database.
          report.unreadable.push(db.stubPath);
          continue;
        }
      }
      const title =
        existing !== null ? extractStubTitle(existing, db.fallbackTitle) : db.fallbackTitle;
      let content = buildStubPage(title, rendered.table);
      if (selected.has('links')) content = decodeLinks(content, { redirectCsv: doTables });
      if (rendered.wide) report.wideTables.push(writePath);

      if (existing === null) {
        changes.push({ path: writePath, content });
        report.stubsCreated += 1;
        report.transforms.tables += 1;
      } else if (content !== existing) {
        changes.push({ path: writePath, content });
        report.transforms.tables += 1;
      }

      // The table now holds the CSV's data, so the CSV is redundant.
      if (opts.removeCsv) {
        deletions.push(db.csvPath);
        report.csvsRemoved += 1;
      }
    }
  }

  report.filesChanged = new Set(changes.map((c) => c.path)).size;
  return { changes, assets, deletions, report };
}

/** Write every change and asset, then remove scheduled files. */
export function applyPlan(plan: Plan): void {
  for (const asset of plan.assets) {
    mkdirSync(dirname(asset.path), { recursive: true });
    writeFileSync(asset.path, asset.bytes);
  }
  for (const change of plan.changes) {
    mkdirSync(dirname(change.path), { recursive: true });
    writeFileSync(change.path, change.content, 'utf8');
  }
  for (const path of plan.deletions) {
    try {
      unlinkSync(path);
    } catch (err) {
      // A file already gone is fine; any other error (EACCES/EPERM/EBUSY) is real
      // and must surface rather than being silently swallowed.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
