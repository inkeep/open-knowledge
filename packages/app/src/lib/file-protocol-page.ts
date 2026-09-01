export function isFileProtocolPage(
  loc: { protocol: string } | undefined = typeof window === 'undefined'
    ? undefined
    : window.location,
): boolean {
  return loc?.protocol === 'file:';
}
