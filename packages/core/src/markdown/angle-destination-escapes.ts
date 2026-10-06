const ASCII_PUNCTUATION_RE = /^[!-/:-@[-`{-~]$/;

export function isAsciiPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && ASCII_PUNCTUATION_RE.test(ch);
}

export function angleDestinationEscapesBracket(ch: string | undefined): boolean {
  return ch === '<' || ch === '>';
}

export function angleDestinationEscapesBackslashBefore(next: string | undefined): boolean {
  return next === undefined || isAsciiPunctuation(next);
}

export function angleDestinationReproducesEscapeOf(ch: string | undefined): boolean {
  return angleDestinationEscapesBracket(ch) || ch === '\\';
}
