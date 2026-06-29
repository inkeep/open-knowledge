
export function frontmatterYamlPath(folderPath: string): string {
  return folderPath === '' ? '.ok/frontmatter.yml' : `${folderPath}/.ok/frontmatter.yml`;
}
