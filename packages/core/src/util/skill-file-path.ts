import { SUPPORTED_DOC_EXTENSIONS } from '../constants/doc-extensions.ts';

export function skillFilePathSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
}

export function isMarkdownSkillFilePath(path: string): boolean {
  const name = skillFilePathSegments(path).at(-1);
  return (
    name !== undefined &&
    SUPPORTED_DOC_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))
  );
}
