export type AttributeLiteral =
  | string
  | number
  | boolean
  | null
  | undefined
  | AttributeLiteral[]
  | { [key: string]: AttributeLiteral };

class LiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): AttributeLiteral {
    this.skipTrivia();
    const value = this.parseValue();
    this.skipTrivia();
    if (this.index < this.source.length) this.fail('unexpected trailing input');
    return value;
  }

  private parseValue(): AttributeLiteral {
    const char = this.peek();
    if (char === '[') return this.parseArray();
    if (char === '{') return this.parseObject();
    if (char === '"' || char === "'") return this.parseQuoted(char);
    if (char === '`') return this.parseTemplate();
    if (char === '-' || (char >= '0' && char <= '9')) return this.parseNumber();

    const word = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.index))?.[0];
    if (word === 'true' || word === 'false' || word === 'null' || word === 'undefined') {
      this.index += word.length;
      return word === 'true' ? true : word === 'false' ? false : word === 'null' ? null : undefined;
    }
    this.fail(word ? `identifier "${word}" is not a literal` : 'expected a literal value');
  }

  private parseArray(): AttributeLiteral[] {
    this.index += 1;
    const items: AttributeLiteral[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === ']') {
        this.index += 1;
        return items;
      }
      items.push(this.parseValue());
      this.skipTrivia();
      if (this.peek() === ',') this.index += 1;
      else if (this.peek() !== ']') this.fail('expected "," or "]"');
    }
  }

  private parseObject(): { [key: string]: AttributeLiteral } {
    this.index += 1;
    const entries: { [key: string]: AttributeLiteral } = {};
    for (;;) {
      this.skipTrivia();
      if (this.peek() === '}') {
        this.index += 1;
        return entries;
      }
      const key = this.parseKey();
      this.skipTrivia();
      if (this.peek() !== ':') this.fail('expected ":" after an object key');
      this.index += 1;
      this.skipTrivia();
      entries[key] = this.parseValue();
      this.skipTrivia();
      if (this.peek() === ',') this.index += 1;
      else if (this.peek() !== '}') this.fail('expected "," or "}"');
    }
  }

  private parseKey(): string {
    const char = this.peek();
    if (char === '"' || char === "'") return this.parseQuoted(char);
    const identifier = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.index))?.[0];
    if (!identifier) this.fail('expected an object key');
    this.index += identifier.length;
    return identifier;
  }

  private parseQuoted(quote: string): string {
    this.index += 1;
    let out = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === quote) {
        this.index += 1;
        return out;
      }
      if (char === '\\') {
        out += this.readEscape();
        continue;
      }
      if (char === '\n') this.fail('unterminated string');
      out += char;
      this.index += 1;
    }
    this.fail('unterminated string');
  }

  private parseTemplate(): string {
    this.index += 1;
    let out = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '`') {
        this.index += 1;
        return out;
      }
      if (char === '\\') {
        out += this.readEscape();
        continue;
      }
      if (char === '$' && this.source[this.index + 1] === '{') {
        this.fail('template interpolation is not a literal');
      }
      out += char;
      this.index += 1;
    }
    this.fail('unterminated template literal');
  }

  private readEscape(): string {
    const escaped = this.source[this.index + 1];
    this.index += 2;
    switch (escaped) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        return '\0';
      case 'u': {
        if (this.source[this.index] === '{') {
          const end = this.source.indexOf('}', this.index);
          if (end === -1) this.fail('unterminated unicode escape');
          const code = this.source.slice(this.index + 1, end);
          this.index = end + 1;
          return this.codePoint(code);
        }
        const code = this.source.slice(this.index, this.index + 4);
        this.index += 4;
        return this.codePoint(code, 4);
      }
      case 'x': {
        const code = this.source.slice(this.index, this.index + 2);
        this.index += 2;
        return this.codePoint(code, 2);
      }
      case '\n':
        return '';
      default:
        return escaped ?? '';
    }
  }

  private codePoint(code: string, width?: number): string {
    if ((width !== undefined && code.length !== width) || !/^[0-9a-fA-F]+$/.test(code)) {
      this.fail('malformed escape sequence');
    }
    const parsed = Number.parseInt(code, 16);
    if (parsed > 0x10_ff_ff) this.fail('escape is beyond the Unicode range');
    return String.fromCodePoint(parsed);
  }

  private parseNumber(): number {
    const matched = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!matched) this.fail('expected a number');
    this.index += matched[0].length;
    return Number(matched[0]);
  }

  private peek(): string {
    return this.source[this.index] ?? '';
  }

  private skipTrivia(): void {
    for (;;) {
      while (this.index < this.source.length && /\s/.test(this.source[this.index] ?? '')) {
        this.index += 1;
      }
      if (this.source.startsWith('//', this.index)) {
        const end = this.source.indexOf('\n', this.index);
        this.index = end === -1 ? this.source.length : end;
        continue;
      }
      if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index);
        if (end === -1) this.fail('unterminated comment');
        this.index = end + 2;
        continue;
      }
      return;
    }
  }

  private fail(reason: string): never {
    const upto = this.source.slice(0, this.index);
    const line = upto.split('\n').length;
    throw new Error(
      `Cannot read MDX attribute expression at line ${line}: ${reason}. ` +
        'Attribute expressions reachable from served Markdown must be plain literals.',
    );
  }
}

export function parseAttributeLiteral(source: string): AttributeLiteral {
  return new LiteralParser(source).parse();
}
