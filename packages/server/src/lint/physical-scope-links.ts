import { readFileSync, realpathSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import {
  addDocumentFolders,
  asTargetNamespace,
  createTargetNamespace,
  createWikiAssetResolver,
  SUPPORTED_DOC_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import { BacklinkIndex } from '../backlink-index.ts';
import { createContentFilter } from '../content-filter.ts';
import { isWithinContentDir } from '../content-path.ts';
import { isSupportedDocFile, stripDocExtension } from '../doc-extensions.ts';
import { assessLocalTargets, createTolerantDocumentResolver } from '../local-target-assessment.ts';
import { isExcludedFileOnDisk } from '../local-target-index.ts';
import { createFileBasenameResolver } from '../local-target-inventory.ts';
import { toPosix } from '../path-utils.ts';
import { readScopeEntry } from './audit-scope.ts';
import type { ValidationAuditDeps, ValidationScope } from './validation-audit.ts';

interface PhysicalScopeLinks {
  source: string;
  file: string;
  deadLinks: ReturnType<BacklinkIndex['getDeadLinks']>;
  localTargets: { source: string; assessments: ReturnType<typeof assessLocalTargets> }[];
}

export function physicalScopeLinks(
  scope: ValidationScope,
  deps: ValidationAuditDeps,
  admitted: readonly string[],
): PhysicalScopeLinks | undefined {
  const selected = scope.resolvedScope;
  if (selected?.kind !== 'file' || !isSupportedDocFile(selected.path)) return undefined;
  const stem = stripDocExtension(selected.path);
  const extension = extname(selected.path).toLowerCase();
  if (
    !SUPPORTED_DOC_EXTENSIONS.some(
      (candidate) =>
        candidate !== extension && readScopeEntry(`${stem}${candidate}`, true)?.isFile(),
    )
  )
    return undefined;

  const file = toPosix(relative(deps.contentDir, selected.path));
  const source = stripDocExtension(file);
  const filter = createContentFilter({ projectDir: deps.projectDir, contentDir: deps.contentDir });
  if (filter.isExcluded(file)) return undefined;
  const canonicalContent = realpathSync(deps.contentDir);
  const canonicalFile = realpathSync(selected.path);
  if (!isWithinContentDir(canonicalFile, canonicalContent))
    throw new Error('symlink-escape: audit scope resolves outside the content directory');

  const live = deps.docFilePathFor(source) === file ? deps.liveSourceFor?.(file) : null;
  const markdown = live ?? readFileSync(canonicalFile, 'utf8');
  const targetExists = (path: string, kind: 'file' | 'dir'): boolean => {
    const full = resolve(deps.contentDir, path);
    if (!isWithinContentDir(full, deps.contentDir)) return false;
    if (kind === 'file' ? filter.isExcluded(path) : filter.isDirExcluded(path)) return false;
    const stat = readScopeEntry(full, true);
    if (stat === undefined) return false;
    if (!isWithinContentDir(realpathSync(full), canonicalContent)) return false;
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  };
  const documents = asTargetNamespace('document', admitted);
  const tracked = deps.localTargetInventory?.() ?? null;
  const files = tracked === null ? null : asTargetNamespace('file', tracked.fileTargets);
  const folders =
    tracked === null
      ? null
      : addDocumentFolders(createTargetNamespace('folder', tracked.folderTargets), documents);
  const resolveFile = (path: string): string | undefined =>
    files === null ? (targetExists(path, 'file') ? path : undefined) : files.resolve(path);
  const resolveFolder = (path: string): string | undefined =>
    folders === null ? (targetExists(path, 'dir') ? path : undefined) : folders.resolve(path);
  const hasFile = (path: string) => resolveFile(path) !== undefined;
  const hasFolder = (path: string) => resolveFolder(path) !== undefined;
  const graph = new BacklinkIndex({
    projectDir: deps.projectDir,
    contentDir: deps.contentDir,
    documentNames: admitted,
    getFileOracle: () => ({ hasFile }),
  });
  graph.updateDocumentFromMarkdown(source, markdown);
  const assessments = assessLocalTargets(markdown, source, {
    resolveDocument: (name) => documents.resolve(name),
    resolveFile,
    resolveFileByBasename: files === null ? null : createFileBasenameResolver(files),
    ...(files === null ? {} : { resolveWikiFile: createWikiAssetResolver(files) }),
    resolveFolder,
    isExcludedFile: (path) => isExcludedFileOnDisk(deps.contentDir, filter, path),
    resolveTolerantDocument: createTolerantDocumentResolver(documents),
  });
  return {
    source,
    file,
    deadLinks: graph.getDeadLinks(admitted, [source]).filter((link) => !hasFolder(link.target)),
    localTargets: [{ source, assessments }],
  };
}
