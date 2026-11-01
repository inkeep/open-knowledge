import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import {
  isSupportedDocFile,
  registerDocExtension,
  SUPPORTED_DOC_EXTENSIONS,
  stripDocExtension,
} from '../doc-extensions.ts';
import { isValidRelativeContentPath } from '../relative-content-path.ts';

export function registerSourceFileExtension(contentDir: string, path: string): void {
  if (!isValidRelativeContentPath(path)) return;
  const resolvedContentDir = resolve(contentDir);
  const inside = (candidate: string) =>
    candidate === resolvedContentDir || candidate.startsWith(`${resolvedContentDir}${sep}`);
  if (isSupportedDocFile(path)) {
    const extensionless = stripDocExtension(path);
    for (const ext of SUPPORTED_DOC_EXTENSIONS) {
      const candidate = resolve(resolvedContentDir, `${extensionless}${ext}`);
      if (inside(candidate) && existsSync(candidate)) registerDocExtension(extensionless, ext);
    }
    const explicitCandidate = resolve(resolvedContentDir, path);
    if (
      explicitCandidate !== resolvedContentDir &&
      inside(explicitCandidate) &&
      existsSync(explicitCandidate)
    ) {
      registerDocExtension(extensionless, extname(path));
    }
    return;
  }
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    const candidate = resolve(resolvedContentDir, `${path}${ext}`);
    if (inside(candidate) && existsSync(candidate)) {
      registerDocExtension(path, ext);
      return;
    }
  }
}
