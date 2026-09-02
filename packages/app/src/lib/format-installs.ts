export function formatInstalls(n: number, locale: string): string {
  return new Intl.NumberFormat(locale || undefined, {
    notation: 'compact',
    compactDisplay: 'short',
  }).format(n);
}
