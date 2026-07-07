/**
 * Path-formatting helper for the folder cascade UI. Keeps the
 * `<folder>/.ok/frontmatter.yml` shape consistent across the FolderOverview
 * cards and any future UI that surfaces this path to the user.
 *
 * Empty `folderPath` means the project root — the server treats empty + `.`
 * + `/` interchangeably, and this helper produces the canonical no-prefix
 * form so the path displays as `.ok/frontmatter.yml` (not `/.ok/frontmatter.yml`
 * or `<root>/.ok/frontmatter.yml`).
 */

/** Project-root-relative path of `<folder>/.ok/frontmatter.yml`. */
export function frontmatterYamlPath(folderPath: string): string {
  return folderPath === '' ? '.ok/frontmatter.yml' : `${folderPath}/.ok/frontmatter.yml`;
}
