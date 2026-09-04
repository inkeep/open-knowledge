export const CODE_FILE_EXTENSIONS_TO_LANGUAGE: Readonly<Record<string, string>> = {
  sh: 'bash',
  zsh: 'bash',
  bash: 'bash',

  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',

  cs: 'csharp',
  css: 'css',
  less: 'less',
  scss: 'scss',
  sass: 'scss',

  diff: 'diff',
  patch: 'diff',

  feature: 'gherkin',

  go: 'go',

  gql: 'graphql',
  graphql: 'graphql',

  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',

  java: 'java',

  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',

  json: 'json',
  jsonc: 'json',

  kt: 'kotlin',
  kts: 'kotlin',

  lua: 'lua',
  makefile: 'makefile',

  md: 'markdown',
  mdx: 'markdown',

  m: 'objectivec',
  mm: 'objectivec',

  pl: 'perl',
  pm: 'perl',

  php: 'php',
  phtml: 'php',

  py: 'python',
  pyi: 'python',
  pyx: 'python',

  r: 'r',
  rb: 'ruby',
  rs: 'rust',

  sql: 'sql',
  swift: 'swift',

  ts: 'typescript',
  tsx: 'typescript',

  xml: 'xml',

  yaml: 'yaml',
  yml: 'yaml',
};

export const CODE_FILE_BARE_NAMES_TO_LANGUAGE: Readonly<Record<string, string>> = {
  makefile: 'makefile',
  dockerfile: 'bash',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

export const CODE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(CODE_FILE_EXTENSIONS_TO_LANGUAGE),
);

export function codeLanguageForExtension(ext: string): string | null {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return CODE_FILE_EXTENSIONS_TO_LANGUAGE[normalized] ?? null;
}

export function codeLanguageForBareFilename(name: string): string | null {
  return CODE_FILE_BARE_NAMES_TO_LANGUAGE[name.toLowerCase()] ?? null;
}

const EDITABLE_TEXT_EXCLUDED: ReadonlySet<string> = new Set(['md', 'mdx', 'mmd', 'mermaid']);

export const EDITABLE_TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    ...CODE_FILE_EXTENSIONS,
    'txt',
    'text',
    'csv',
    'tsv',
    'log',
    'toml',
    'html',
    'htm',
    'svg',
    'vue',
    'svelte',
    'astro',
    'lock',
  ].filter((ext) => !EDITABLE_TEXT_EXCLUDED.has(ext)),
);

export const EDITABLE_TEXT_EXTRA_LANGUAGE: Readonly<Record<string, string>> = {
  html: 'html',
  htm: 'html',
  svg: 'xml',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  lock: 'yaml',
};

export function isEditableTextDocFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const lastDot = base.lastIndexOf('.');
  if (lastDot <= 0) return false;
  return EDITABLE_TEXT_FILE_EXTENSIONS.has(base.slice(lastDot + 1).toLowerCase());
}
