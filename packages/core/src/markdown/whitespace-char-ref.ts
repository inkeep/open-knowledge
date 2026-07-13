
const INLINE_WHITESPACE_BY_CODE: ReadonlyMap<number, string> = new Map([
  [0x20, ' '],
  [0x09, '\t'],
]);

function numericCharRefCodePoint(ref: string): number | null {
  const match = /^&#(x[0-9A-Fa-f]+|X[0-9A-Fa-f]+|[0-9]+);$/.exec(ref);
  if (!match) return null;
  const body = match[1];
  const hex = body[0] === 'x' || body[0] === 'X';
  const code = Number.parseInt(hex ? body.slice(1) : body, hex ? 16 : 10);
  return Number.isNaN(code) ? null : code;
}

export function isInlineWhitespaceNumericCharRef(ref: string): boolean {
  const code = numericCharRefCodePoint(ref);
  return code !== null && INLINE_WHITESPACE_BY_CODE.has(code);
}

export function decodeInlineWhitespaceNumericCharRef(ref: string): string | null {
  const code = numericCharRefCodePoint(ref);
  return code === null ? null : (INLINE_WHITESPACE_BY_CODE.get(code) ?? null);
}

const NUMERIC_CHAR_REF_TOKEN = /&#(?:x[0-9A-Fa-f]+|X[0-9A-Fa-f]+|[0-9]+);/g;

export function decodeInlineWhitespaceNumericCharRefRun(refRun: string): string | null {
  NUMERIC_CHAR_REF_TOKEN.lastIndex = 0;
  const tokens = refRun.match(NUMERIC_CHAR_REF_TOKEN);
  if (tokens === null || tokens.join('') !== refRun) return null;
  let decoded = '';
  for (const token of tokens) {
    const char = decodeInlineWhitespaceNumericCharRef(token);
    if (char === null) return null;
    decoded += char;
  }
  return decoded;
}
