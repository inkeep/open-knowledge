const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

export function stripInvisibleCharacters(value: string): string {
  return value.replace(INVISIBLE_CHARACTERS, '');
}

export function mapControlCharactersToSpace(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point; this is the one place that decides what a control character is.
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

export function isBlankNoteContent(value: string): boolean {
  return mapControlCharactersToSpace(stripInvisibleCharacters(value)).trim() === '';
}

export function clampToCodeUnits(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) return value;
  const clamped = value.slice(0, maxCodeUnits);
  const lastUnit = clamped.charCodeAt(clamped.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? clamped.slice(0, -1) : clamped;
}
