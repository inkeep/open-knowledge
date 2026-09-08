const DOCS_URL_BASE =
  'https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md';

export function docsUrl(ruleName) {
  return `${DOCS_URL_BASE}#${ruleName}`;
}
