import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SyntheticDocSpec {
  readonly docName: string;
  readonly fileName: string;
  readonly title: string;
  readonly targetBytes: number;
  readonly linkCount: number;
  readonly wideRowChars: number;
  readonly seed: number;
}

export const BIG_DOC: SyntheticDocSpec = {
  docName: 'perf-fixtures/big-doc',
  fileName: 'big-doc.md',
  title: 'Synthetic big document',
  targetBytes: 3_250_000,
  linkCount: 768,
  wideRowChars: 3000,
  seed: 0x0b16_d0c5,
};

export const MEDIUM_DOC: SyntheticDocSpec = {
  docName: 'perf-fixtures/medium-doc',
  fileName: 'medium-doc.md',
  title: 'Synthetic medium document',
  targetBytes: 530_000,
  linkCount: 176,
  wideRowChars: 0,
  seed: 0x0aed_d0c5,
};

export const SYNTHETIC_DOCS: readonly SyntheticDocSpec[] = [BIG_DOC, MEDIUM_DOC];

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = resolve(HERE, '..', '..', '..', '..', '..', 'perf-fixtures');

const WORDS = [
  'anchor',
  'baseline',
  'branch',
  'buffer',
  'cache',
  'canonical',
  'capture',
  'channel',
  'checkpoint',
  'client',
  'collaboration',
  'commit',
  'conflict',
  'context',
  'cursor',
  'decoration',
  'delta',
  'document',
  'editor',
  'fragment',
  'graph',
  'heading',
  'history',
  'index',
  'invariant',
  'latency',
  'layout',
  'lifecycle',
  'listener',
  'marker',
  'merge',
  'namespace',
  'observer',
  'origin',
  'outline',
  'paragraph',
  'persistence',
  'portal',
  'presence',
  'protocol',
  'render',
  'replica',
  'schema',
  'segment',
  'session',
  'snapshot',
  'source',
  'stream',
  'surface',
  'timeline',
  'token',
  'transaction',
  'viewport',
  'watcher',
  'workspace',
];

const CODE_LINES = [
  'const doc = new Y.Doc();',
  'const text = doc.getText("source");',
  'doc.transact(() => text.insert(0, "hello"), origin);',
  'provider.on("synced", () => console.log("ready"));',
  'export function markerFor(name: string): string | null {',
  '  return DOC_MARKERS[name] ?? null;',
  '}',
  'await page.goto(target + "/#/" + encodeURIComponent(docName));',
  'const longest = tasks.reduce((m, t) => Math.max(m, t.duration), 0);',
  'if (bytes > threshold) deferMount(editor);',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Writer {
  private readonly parts: string[] = [];
  private length = 0;

  push(chunk: string): void {
    this.parts.push(chunk);
    this.length += chunk.length;
  }

  get bytes(): number {
    return this.length;
  }

  toString(): string {
    return this.parts.join('');
  }
}

class Generator {
  private readonly rng: () => number;
  private readonly out = new Writer();
  private linksEmitted = 0;
  private sectionIndex = 0;

  constructor(private readonly spec: SyntheticDocSpec) {
    this.rng = mulberry32(spec.seed);
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.rng() * (max - min + 1));
  }

  private word(): string {
    return WORDS[Math.floor(this.rng() * WORDS.length)] ?? 'document';
  }

  private capitalized(): string {
    const w = this.word();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  private words(count: number): string {
    const acc: string[] = [];
    for (let i = 0; i < count; i++) acc.push(this.word());
    return acc.join(' ');
  }

  private linkDue(): boolean {
    if (this.linksEmitted >= this.spec.linkCount) return false;
    const perLink = this.spec.targetBytes / this.spec.linkCount;
    return this.out.bytes >= this.linksEmitted * perLink;
  }

  private link(): string {
    this.linksEmitted += 1;
    const n = this.linksEmitted;
    const target =
      n % 3 === 0
        ? `https://example.com/${this.word()}/${this.word()}-${n}`
        : n % 3 === 1
          ? `../reports/${this.word()}-${this.word()}/REPORT.md`
          : `#${this.word()}-${n}`;
    return `[${this.words(this.int(1, 3))}](${target})`;
  }

  private span(): string {
    const roll = this.rng();
    if (roll < 0.12) return `**${this.words(this.int(1, 3))}**`;
    if (roll < 0.24) return `\`${this.word()}.${this.word()}\``;
    if (roll < 0.3) return `*${this.words(this.int(1, 2))}*`;
    return this.words(this.int(2, 6));
  }

  private sentence(): string {
    const spans: string[] = [this.capitalized()];
    const count = this.int(2, 6);
    for (let i = 0; i < count; i++) spans.push(this.span());
    if (this.linkDue()) spans.push(this.link());
    return `${spans.join(' ')}.`;
  }

  private paragraph(): string {
    const count = this.int(2, 5);
    const acc: string[] = [];
    for (let i = 0; i < count; i++) acc.push(this.sentence());
    return `${acc.join(' ')}\n\n`;
  }

  private list(): string {
    const count = this.int(3, 6);
    const acc: string[] = [];
    for (let i = 0; i < count; i++) {
      const nested = this.rng() < 0.3 ? `\n  - ${this.sentence()}` : '';
      acc.push(`- ${this.sentence()}${nested}`);
    }
    return `${acc.join('\n')}\n\n`;
  }

  private cell(wide: boolean): string {
    if (!wide) return this.words(this.int(2, 7));
    const acc: string[] = [];
    let len = 0;
    while (len < this.spec.wideRowChars) {
      const s = this.sentence();
      acc.push(s);
      len += s.length + 1;
    }
    return acc.join(' ');
  }

  private table(): string {
    const cols = this.int(3, 5);
    const header = Array.from({ length: cols }, () => this.capitalized());
    const rows = this.int(6, 12);
    const lines: string[] = [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
    ];
    for (let r = 0; r < rows; r++) {
      const wide = this.spec.wideRowChars > 0 && r % 5 === 2;
      const cells: string[] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(c === cols - 1 && wide ? this.cell(true) : this.cell(false));
      }
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return `${lines.join('\n')}\n\n`;
  }

  private code(): string {
    const count = this.int(3, 8);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(CODE_LINES[Math.floor(this.rng() * CODE_LINES.length)] ?? '');
    }
    return `\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n\n`;
  }

  private quote(): string {
    return `> ${this.sentence()}\n>\n> ${this.sentence()}\n\n`;
  }

  private section(): void {
    this.sectionIndex += 1;
    const n = this.sectionIndex;
    this.out.push(`## ${n}. ${this.capitalized()} ${this.words(this.int(1, 3))}\n\n`);
    const paragraphs = this.int(2, 4);
    for (let i = 0; i < paragraphs; i++) this.out.push(this.paragraph());
    if (n % 2 === 0) {
      this.out.push(`### ${this.capitalized()} ${this.words(2)}\n\n`);
      this.out.push(this.paragraph());
    }
    this.out.push(this.list());
    if (n % 3 === 0) this.out.push(this.table());
    if (n % 4 === 0) this.out.push(this.code());
    if (n % 5 === 0) this.out.push(this.quote());
  }

  generate(): string {
    this.out.push(`# ${this.spec.title}\n\n`);
    this.out.push(
      `Generated by \`packages/app/tests/perf/fixtures/synthetic-doc.ts\` from seed ${this.spec.seed}. Every sentence is filler; only the shape matters.\n\n`,
    );
    while (this.out.bytes < this.spec.targetBytes) this.section();
    while (this.linksEmitted < this.spec.linkCount) {
      this.out.push(`${this.capitalized()} ${this.words(3)} ${this.link()}.\n\n`);
    }
    return this.out.toString();
  }
}

export function generateSyntheticDoc(spec: SyntheticDocSpec): string {
  return new Generator(spec).generate();
}

export function countLinks(markdown: string): number {
  return (markdown.match(/\]\(/g) ?? []).length;
}

export interface WriteResult {
  readonly path: string;
  readonly bytes: number;
  readonly written: boolean;
}

export function writeSyntheticFixtures(options: { force?: boolean } = {}): WriteResult[] {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  return SYNTHETIC_DOCS.map((spec) => {
    const path = join(FIXTURES_DIR, spec.fileName);
    if (!options.force && existsSync(path)) {
      return { path, bytes: 0, written: false };
    }
    const content = generateSyntheticDoc(spec);
    writeFileSync(path, content, 'utf8');
    return { path, bytes: Buffer.byteLength(content, 'utf8'), written: true };
  });
}
