export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
}
