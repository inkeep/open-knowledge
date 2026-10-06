import type { WriteAdvisoryTargets } from './write-advisory-links.ts';

const fileCapabilities = {
  fileExists: () => false,
  fileExcluded: () => false,
  resolveWikiFile: () => undefined,
  resolveFileByBasename: () => undefined,
};

// @ts-expect-error — a write route that omits folder resolution must not compile.
const _omitsFolders: WriteAdvisoryTargets = fileCapabilities;
const _optsOutOfFolders: WriteAdvisoryTargets = { ...fileCapabilities, folderExists: null };
const _optsOutOfFiles: WriteAdvisoryTargets = {
  fileExists: null,
  folderExists: () => false,
  fileExcluded: null,
  resolveWikiFile: null,
  resolveFileByBasename: null,
};
void _omitsFolders;
void _optsOutOfFolders;
void _optsOutOfFiles;
