import { extname } from 'node:path';
import {
  DEFAULT_DOC_EXTENSION,
  type DocExtension,
  isEditableTextDocFile,
  isExcalidrawDocFile,
  isMermaidDocFile,
  SUPPORTED_DOC_EXTENSIONS,
} from '@inkeep/open-knowledge-core';

export { SUPPORTED_DOC_EXTENSIONS };

const DEFAULT_EXTENSION: DocExtension = DEFAULT_DOC_EXTENSION;

export function isSupportedDocFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return (SUPPORTED_DOC_EXTENSIONS as readonly string[]).includes(ext);
}

export function isSupportedAssetFile(path: string, assetExtensions: ReadonlySet<string>): boolean {
  const ext = extname(path).slice(1).toLowerCase();
  return ext.length > 0 && assetExtensions.has(ext);
}

export function stripDocExtension(path: string): string {
  const lower = path.toLowerCase();
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return path.slice(0, -ext.length);
  }
  return path;
}

function canonicalize(ext: string): DocExtension | null {
  const lower = ext.toLowerCase();
  if (lower === '.mdx') return '.mdx';
  if (lower === '.md') return '.md';
  return null;
}

function rank(ext: DocExtension): number {
  return SUPPORTED_DOC_EXTENSIONS.indexOf(ext);
}

const docExtensionByName = new Map<string, string>();

const shadowedExtByName = new Map<string, string>();

export function registerDocExtension(
  docName: string,
  observedExt: string,
): { effective: string; changed: boolean; shadowed: string | null } {
  const canonical = canonicalize(observedExt);
  if (!canonical) {
    throw new Error(`registerDocExtension: unsupported extension "${observedExt}"`);
  }
  const existing = docExtensionByName.get(docName);
  if (!existing) {
    docExtensionByName.set(docName, observedExt);
    shadowedExtByName.delete(docName);
    return { effective: observedExt, changed: true, shadowed: null };
  }
  const existingCanonical = canonicalize(existing);
  if (!existingCanonical) {
    docExtensionByName.set(docName, observedExt);
    shadowedExtByName.set(docName, existing);
    return { effective: observedExt, changed: true, shadowed: existing };
  }
  if (existingCanonical === canonical) {
    return { effective: existing, changed: false, shadowed: null };
  }
  if (rank(canonical) < rank(existingCanonical)) {
    docExtensionByName.set(docName, observedExt);
    shadowedExtByName.set(docName, existing);
    return { effective: observedExt, changed: true, shadowed: existing };
  }
  shadowedExtByName.set(docName, observedExt);
  return { effective: existing, changed: false, shadowed: observedExt };
}

export function getDocExtension(docName: string): string {
  return docExtensionByName.get(docName) ?? DEFAULT_EXTENSION;
}

export function isRegisteredMarkdownDocName(docName: string): boolean {
  const recorded = docExtensionByName.get(docName);
  return recorded === '.md' || recorded === '.mdx';
}

export function canonicalDocName(docName: string): string {
  if (!isSupportedDocFile(docName)) return docName;
  if (addressesShadowedSibling(docName)) return docName;
  let candidate = docName;
  while (isSupportedDocFile(candidate)) {
    candidate = stripDocExtension(candidate);
  }
  return candidate;
}

function addressesShadowedSibling(docName: string): boolean {
  const stem = stripDocExtension(docName);
  if (stem === docName) return false;
  const shadowed = shadowedExtByName.get(stem);
  if (shadowed === undefined) return false;
  return docName.slice(stem.length).toLowerCase() === shadowed.toLowerCase();
}

export function docNameToRelativePath(docName: string): string {
  return isSupportedDocFile(docName) ||
    isMermaidDocFile(docName) ||
    isExcalidrawDocFile(docName) ||
    (isEditableTextDocFile(docName) && !isRegisteredMarkdownDocName(docName))
    ? docName
    : `${docName}${getDocExtension(docName)}`;
}

export function extensionlessDocTreePath(fullPath: string, docName: string): string | null {
  const ext = getDocExtension(docName);
  if (ext.length > 0 && fullPath.endsWith(ext)) {
    const stripped = fullPath.slice(0, -ext.length);
    if (stripped.length > 0 && stripped !== fullPath) return stripped;
  }
  return null;
}

export function forgetDocExtension(docName: string): void {
  shadowedExtByName.delete(docName);
  docExtensionByName.delete(docName);
}

export function _resetDocExtensionsForTests(): void {
  shadowedExtByName.clear();
  docExtensionByName.clear();
}
