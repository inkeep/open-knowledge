export const SUPPORTED_DOC_EXTENSIONS = ['.mdx', '.md'] as const;

export type DocExtension = (typeof SUPPORTED_DOC_EXTENSIONS)[number];

export const DEFAULT_DOC_EXTENSION: DocExtension = '.md';
