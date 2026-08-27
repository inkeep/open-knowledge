const MARKDOWNLINT_JSON_CONFIG_FILES: ReadonlySet<string> = new Set([
  '.markdownlint.json',
  '.markdownlint.jsonc',
]);

export function isMarkdownlintJsonConfig(basename: string): boolean {
  return MARKDOWNLINT_JSON_CONFIG_FILES.has(basename);
}
