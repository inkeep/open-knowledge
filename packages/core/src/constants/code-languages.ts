/**
 * Map source-file extensions to the canonical codeblock language ID
 * (matches `CODE_BLOCK_LANGUAGES` in the app's slash-menu picker —
 * highlight.js / lowlight language keys, which also serialize as
 * markdown info-string tokens so the WYSIWYG ↔ source round-trip is
 * byte-stable).
 *
 * Used by the sidebar / `AssetPreview` dispatch so a file like `foo.ts`
 * opens by default in the read-only `TextViewer` with the right
 * CodeMirror language pack, mirroring the syntax-highlighting authors
 * already see inside fenced ```ts code blocks.
 *
 * Extensions in this table that are ALSO in `SIDEBAR_TEXT_EXTENSIONS`
 * (`json` / `toml`) are kept here for completeness — the `mediaKindForSidebarAssetExtension`
 * dispatch checks the smaller set first, so the duplicate is harmless.
 *
 * Pure data — no DOM, no React. Imported from both `upload.ts` (for
 * the asset-kind dispatch) and the app's `TextViewer` (for the CM
 * language-pack pick).
 */

/**
 * Extension → canonical codeblock language ID. Lowercase, no leading dot.
 * The canonical IDs match `CODE_BLOCK_LANGUAGES[].value` in
 * `packages/app/src/editor/extensions/code-block-languages.ts`.
 */
export const CODE_FILE_EXTENSIONS_TO_LANGUAGE: Readonly<Record<string, string>> = {
  // Bash / shell — `.sh` / `.zsh` / `.bash` all funnel to the canonical
  // `bash` codeblock language (shell-session prompts are a separate
  // `shell` grammar; not surfaced as a file extension since most shell
  // scripts ship as `.sh` source, not transcripts).
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
  // CSS family — `less` / `scss` ride the same `css` lang pack via
  // dialect config; canonical codeblock IDs stay distinct so the
  // info-string round-trip matches what users type.
  css: 'css',
  less: 'less',
  scss: 'scss',
  sass: 'scss',

  // Diff / patch — `.diff` / `.patch` are file-extension conventions; the
  // canonical codeblock ID is `diff`.
  diff: 'diff',
  patch: 'diff',

  go: 'go',

  // GraphQL — `.gql` / `.graphql` both used in practice.
  gql: 'graphql',
  graphql: 'graphql',

  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',

  java: 'java',

  // JavaScript — `mjs` / `cjs` are the ESM / CJS variants; the codeblock
  // grammar handles all three (TypeScript JSX is its own entry below).
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',

  // JSON — canonical codeblock `json` covers `jsonc` (JSON-with-comments).
  json: 'json',
  jsonc: 'json',

  kt: 'kotlin',
  kts: 'kotlin',

  lua: 'lua',
  makefile: 'makefile',
  // Conventional bare-name files (no extension) — the lookup is
  // extension-keyed, so these are reachable via the bare-name probe
  // below in `codeLanguageForExtension`.

  // Markdown — these almost always render as the WYSIWYG editor instead,
  // but the codeblock language ID is `markdown` and a sidebar override
  // would still want syntax highlighting via the CM markdown lang pack.
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

  // XML — `html` / `htm` / `svg` are intentionally NOT routed here.
  // - `html` / `htm` carry an inline-rendering path under
  //   `SANDBOXED_HTML_CSP`; switching them to text-mode would silently
  //   change the sidebar render.
  // - `svg` is excluded from `SIDEBAR_IMAGE_ASSET_EXTENSIONS` for XSS
  //   reasons but does not yet have a sidebar viewer — the "Open with
  //   built-in text editor" override is the current path. Surfacing
  //   the XML source by default would change a deliberately-conservative
  //   render.
  xml: 'xml',

  yaml: 'yaml',
  yml: 'yaml',
};

/**
 * Bare filenames (no extension) recognized as a code file by the
 * sidebar dispatch. Conventional case-insensitive matches like
 * `Makefile`, `Dockerfile`, `Gemfile`.
 */
export const CODE_FILE_BARE_NAMES_TO_LANGUAGE: Readonly<Record<string, string>> = {
  makefile: 'makefile',
  dockerfile: 'bash',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

/**
 * Set of all extensions present in the extension table — used as a
 * fast O(1) membership probe in `mediaKindForSidebarAssetExtension`.
 * Bare-name matches are NOT in this set (they're handled separately by
 * `codeLanguageForExtension` when the caller passes the filename).
 */
export const CODE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(CODE_FILE_EXTENSIONS_TO_LANGUAGE),
);

/**
 * Return the canonical codeblock language ID for a file extension, or
 * `null` when the extension is not recognized.
 *
 * `ext` may carry a leading dot (`.ts`) and any case; both are
 * normalized away before the lookup.
 */
export function codeLanguageForExtension(ext: string): string | null {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return CODE_FILE_EXTENSIONS_TO_LANGUAGE[normalized] ?? null;
}

/**
 * Return the canonical codeblock language ID for an extension-less
 * bare filename (e.g. `Makefile`, `Dockerfile`), or `null` otherwise.
 *
 * Callers that have a filename in hand should consult both this AND
 * `codeLanguageForExtension`. The two are kept separate so the
 * extension probe stays O(1) on the hot dispatch path.
 */
export function codeLanguageForBareFilename(name: string): string | null {
  return CODE_FILE_BARE_NAMES_TO_LANGUAGE[name.toLowerCase()] ?? null;
}
