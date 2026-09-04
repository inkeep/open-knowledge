import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const API_EXT_PATH = join(SERVER_SRC_ROOT, 'api-extension.ts');
const FILE_WATCHER_PATH = join(SERVER_SRC_ROOT, 'file-watcher.ts');
const SERVER_FACTORY_PATH = join(SERVER_SRC_ROOT, 'server-factory.ts');
const SEARCH_SERVICE_PATH = join(SERVER_SRC_ROOT, 'services/search.ts');
const LOCAL_TARGET_INVENTORY_PATH = join(SERVER_SRC_ROOT, 'local-target-inventory.ts');
const DOCUMENT_ROUTES_PATH = join(SERVER_SRC_ROOT, 'http/document-routes.ts');

const ALLOWLISTED_SITES: ReadonlySet<string> = new Set<string>([
  'applyDiskEventToLiveAllFilesIndex',
  'buildWorkspaceSearchDocumentsFromIndex',
  'workspaceSearchFingerprint',
  'deriveFolderSearchDocuments',
  'handleDocumentList',
  'createLinkedFileExists',
]);

function findEnclosingFn(source: string, offset: number): string {
  const fragment = source.slice(0, offset);
  const lineStart = fragment.lastIndexOf('\n') + 1;
  const callIndent = (/^[ \t]*/.exec(fragment.slice(lineStart))?.[0] ?? '').length;
  const decl =
    /^([ \t]*)(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)/gm;
  let enclosing = '<unknown>';
  for (const match of fragment.matchAll(decl)) {
    if ((match[1]?.length ?? 0) < callIndent) enclosing = match[2] ?? match[3] ?? enclosing;
  }
  return enclosing;
}

function windowFiltersOnKind(window: string): boolean {
  return /\.kind\s*(?:===|!==)\s*['"](markdown|file)['"]/.test(window);
}

interface CallSite {
  file: string;
  line: number;
  fn: string;
  window: string;
}

function collectAllFilesCallSites(filePath: string): CallSite[] {
  const source = readFileSync(filePath, 'utf8');
  const sites: CallSite[] = [];
  for (const match of source.matchAll(/getAllFilesIndex\s*\(/g)) {
    const offset = match.index ?? 0;
    const line = source.slice(0, offset).split('\n').length;
    const fn = findEnclosingFn(source, offset);
    const window = source.slice(Math.max(0, offset - 600), Math.min(source.length, offset + 600));
    sites.push({ file: filePath, line, fn, window });
  }
  return sites;
}

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (st.isFile() && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('PRD-7117 US-002 — getAllFilesIndex caller coverage (D12 §13-A)', () => {
  test('every getAllFilesIndex() call site in api-extension.ts is allowlisted or kind-filtered', () => {
    const sites = [
      ...collectAllFilesCallSites(API_EXT_PATH),
      ...collectAllFilesCallSites(SEARCH_SERVICE_PATH),
      ...collectAllFilesCallSites(DOCUMENT_ROUTES_PATH),
    ];
    const failures: string[] = [];
    for (const site of sites) {
      const allowed = ALLOWLISTED_SITES.has(site.fn);
      const filtered = windowFiltersOnKind(site.window);
      if (!allowed && !filtered) {
        failures.push(
          `${site.file}:${site.line} — enclosing fn "${site.fn}" is neither on ALLOWLISTED_SITES nor narrows on \`.kind\`. ` +
            'A new getAllFilesIndex() consumer must be added to ALLOWLISTED_SITES (with rationale) ' +
            'OR must structurally guard via `entry.kind === "markdown"` / similar inside the call site.',
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test('getAllFilesIndex() is not called from any other server-side production file', () => {
    const allowedFiles = new Set([
      FILE_WATCHER_PATH,
      API_EXT_PATH,
      SERVER_FACTORY_PATH,
      SEARCH_SERVICE_PATH,
      LOCAL_TARGET_INVENTORY_PATH,
      DOCUMENT_ROUTES_PATH,
    ]);
    const offenders: string[] = [];
    for (const file of listProductionTsFiles(SERVER_SRC_ROOT)) {
      if (allowedFiles.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      if (/getAllFilesIndex\s*\(/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('ALLOWLISTED_SITES function names actually exist in a scanned source', () => {
    const source =
      readFileSync(API_EXT_PATH, 'utf8') +
      readFileSync(SEARCH_SERVICE_PATH, 'utf8') +
      readFileSync(DOCUMENT_ROUTES_PATH, 'utf8');
    const missing: string[] = [];
    for (const name of ALLOWLISTED_SITES) {
      const fnRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
      const constRe = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\S`);
      if (!fnRe.test(source) && !constRe.test(source)) {
        missing.push(
          `${name}: function declaration not found in api-extension.ts — either rename/remove dropped the site, ` +
            'or the allowlist entry is stale.',
        );
      }
    }
    expect(missing).toEqual([]);
  });
});
