import { extractPageDescription, extractPageTitle, extractPageType } from '../page-identity.ts';
import { buildIndexMarkdown, type IndexEntry, type SubdirectoryEntry } from './generate-index.ts';

export const ROOT_INDEX_DOC_NAME = 'index';

const RESERVED_STEMS: ReadonlySet<string> = new Set(['index', 'log']);

export interface IndexSourceDoc {
  title?: string | undefined;
  description?: string | undefined;
  type?: string | undefined;
}

export interface PreviousIndexedFields {
  title?: string | undefined;
  description?: string | undefined;
  type?: string | undefined;
}

export interface DirectoryIndexDeps {
  docs: Iterable<readonly [string, IndexSourceDoc]>;
  docExtension: (docName: string) => string;
  currentMarkdownFor: (directory: string) => string | null;
}

export interface DirectoryIndexDecision {
  directory: string;
  changed: boolean;
  markdown: string;
}

function isInfrastructurePath(docName: string): boolean {
  return docName.split('/').some((segment) => segment.startsWith('.'));
}

function basenameOf(docName: string): string {
  return docName.split('/').pop() ?? docName;
}

export function directoryOf(docName: string): string {
  const slash = docName.lastIndexOf('/');
  return slash === -1 ? '' : docName.slice(0, slash);
}

export function directoryChainToRoot(directory: string): string[] {
  const chain: string[] = [];
  let current = directory;
  while (current !== '') {
    chain.push(current);
    current = directoryOf(current);
  }
  chain.push('');
  return chain;
}

export function isGeneratedIndexDocName(docName: string): boolean {
  return basenameOf(docName) === ROOT_INDEX_DOC_NAME;
}

function isAdmittedEntry(docName: string): boolean {
  return !RESERVED_STEMS.has(basenameOf(docName)) && !isInfrastructurePath(docName);
}

function toIndexEntry(
  docName: string,
  meta: IndexSourceDoc,
  docExtension: (docName: string) => string,
): IndexEntry {
  return {
    path: `${docName}${docExtension(docName)}`,
    title: meta.title ?? basenameOf(docName),
    description: meta.description,
    type: meta.type,
  };
}

export function collectIndexDirectories(docNames: Iterable<string>): Set<string> {
  const directories = new Set<string>(['']);

  for (const docName of docNames) {
    if (!isAdmittedEntry(docName)) continue;

    const segments = docName.split('/');
    segments.pop();
    let directory = '';
    for (const segment of segments) {
      directory = directory === '' ? segment : `${directory}/${segment}`;
      directories.add(directory);
    }
  }

  return directories;
}

function depthOf(directory: string): number {
  return directory === '' ? 0 : directory.split('/').length;
}

export function planDirectoryIndexRegenerations(
  deps: DirectoryIndexDeps,
): DirectoryIndexDecision[] {
  const docs = [...deps.docs];
  const directories = collectIndexDirectories(docs.map(([docName]) => docName));

  const entriesByDirectory = new Map<string, IndexEntry[]>();
  for (const [docName, meta] of docs) {
    if (!isAdmittedEntry(docName)) continue;
    const directory = directoryOf(docName);
    const bucket = entriesByDirectory.get(directory);
    if (bucket) bucket.push(toIndexEntry(docName, meta, deps.docExtension));
    else entriesByDirectory.set(directory, [toIndexEntry(docName, meta, deps.docExtension)]);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const directory of directories) {
    if (directory === '') continue;
    const parent = directoryOf(directory);
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(directory);
    else childrenByParent.set(parent, [directory]);
  }

  const decisions = [...directories].map((directory): DirectoryIndexDecision => {
    const entries = entriesByDirectory.get(directory) ?? [];
    const subdirectories: SubdirectoryEntry[] = (childrenByParent.get(directory) ?? []).map(
      (child) => ({ path: `${child}/${ROOT_INDEX_DOC_NAME}.md`, title: basenameOf(child) }),
    );
    const markdown = buildIndexMarkdown(entries, {
      isRoot: directory === '',
      directory,
      subdirectories,
    });
    return { directory, changed: deps.currentMarkdownFor(directory) !== markdown, markdown };
  });

  return decisions.sort(
    (left, right) =>
      depthOf(right.directory) - depthOf(left.directory) ||
      (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0),
  );
}

export function indexedFieldsChanged(
  previousMarkdown: string | null | undefined,
  nextMarkdown: string,
  docName: string,
): boolean {
  const previous = previousMarkdown ?? '';
  return (
    extractPageTitle(previous, docName) !== extractPageTitle(nextMarkdown, docName) ||
    extractPageDescription(previous) !== extractPageDescription(nextMarkdown) ||
    extractPageType(previous) !== extractPageType(nextMarkdown)
  );
}

export function indexedMetadataChanged(
  previous: PreviousIndexedFields | undefined,
  nextMarkdown: string,
  docName: string,
): boolean {
  if (previous === undefined) return true;
  return (
    previous.title !== extractPageTitle(nextMarkdown, docName) ||
    previous.description !== extractPageDescription(nextMarkdown) ||
    previous.type !== extractPageType(nextMarkdown)
  );
}
