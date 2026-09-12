export function escapeDisplayPath(path: string): string {
  return path.replace(
    /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\u200b\ufeff]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
