import { resolve } from 'node:path';
import { docNameToRelativePath } from './doc-extensions.ts';
import { isWithinDir } from './path-utils.ts';

export function safeContentPath(documentName: string, contentDir: string): string {
  if (documentName.includes('\x00')) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  const relativePath = docNameToRelativePath(documentName);
  const filePath = resolve(contentDir, relativePath);
  if (!isWithinDir(filePath, contentDir)) {
    throw new Error(`Invalid document name: ${documentName}`);
  }
  return filePath;
}

export function isWithinContentDir(p: string, contentDir: string): boolean {
  return isWithinDir(p, contentDir);
}
