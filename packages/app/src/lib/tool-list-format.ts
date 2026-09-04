export function formatToolList(labels: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale || undefined, {
    style: 'long',
    type: 'conjunction',
  }).format(labels);
}
