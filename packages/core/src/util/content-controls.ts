export function isDisallowedContentControl(codePoint: number): boolean {
  return (
    codePoint >= 0 && codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13
  );
}
