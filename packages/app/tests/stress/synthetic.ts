/**
 * Deterministic synthetic markdown generator for CRDT stress tests.
 *
 * Produces reproducible markdown at any requested line count with realistic
 * structure: headings, paragraphs, lists, code blocks. Line N always produces
 * the same content given the same parameters.
 */

interface GenerateMarkdownOptions {
  /** Include emoji, CJK, and combining marks in content */
  unicode?: boolean;
  /** Omit trailing newline to exercise applyUserDelta unterminated-final-line path */
  noTrailingNewline?: boolean;
}

const LOREM_WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'do',
  'eiusmod',
  'tempor',
  'incididunt',
  'ut',
  'labore',
  'et',
  'dolore',
  'magna',
  'aliqua',
  'enim',
  'ad',
  'minim',
  'veniam',
  'quis',
  'nostrud',
  'exercitation',
  'ullamco',
  'laboris',
  'nisi',
  'aliquip',
  'ex',
  'ea',
  'commodo',
  'consequat',
  'duis',
  'aute',
  'irure',
  'in',
  'reprehenderit',
  'voluptate',
  'velit',
  'esse',
  'cillum',
  'fugiat',
  'nulla',
  'pariatur',
  'excepteur',
  'sint',
  'occaecat',
  'cupidatat',
  'non',
  'proident',
  'sunt',
  'culpa',
  'qui',
  'officia',
  'deserunt',
  'mollit',
  'anim',
  'id',
  'est',
  'laborum',
];

const UNICODE_WORDS = [
  '\u{1F680}rocket',
  '\u{2728}spark',
  '\u{1F4A1}idea',
  '\u{1F30D}world',
  '\u{4E16}\u{754C}',
  '\u{6D4B}\u{8BD5}',
  '\u{30C6}\u{30B9}\u{30C8}',
  '\u{D14C}\u{C2A4}\u{D2B8}',
  'caf\u0065\u0301',
  'nai\u0308ve',
  'resu\u0301me\u0301',
  '\u{1F468}\u{200D}\u{1F4BB}dev',
  '\u{1F469}\u{200D}\u{1F52C}sci',
];

/** Deterministic word selection based on line index + position */
function word(lineIdx: number, wordIdx: number, unicode: boolean): string {
  const pool = unicode ? UNICODE_WORDS : LOREM_WORDS;
  const idx = (((lineIdx * 31 + wordIdx * 7) % pool.length) + pool.length) % pool.length;
  return pool[idx];
}

/** Generate a deterministic sentence fragment for a given line index */
function sentence(lineIdx: number, wordCount: number, unicode: boolean): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(word(lineIdx, i, unicode));
  }
  // Capitalize first word
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

/**
 * Generate deterministic markdown at any requested line count.
 *
 * Structure cycles through a repeating pattern per 20-line block:
 * - Line 0: ## heading
 * - Lines 1-4: paragraph (4 lines of prose)
 * - Line 5: empty line
 * - Lines 6-9: bullet list (4 items)
 * - Line 10: empty line
 * - Lines 11-16: code block (``` + 4 code lines + ```)
 * - Line 17: empty line
 * - Line 18: wiki-link paragraph (~5% frequency — atom-node coverage)
 * - Line 19: short paragraph
 *
 * Per 20-line block: 7 prose lines (35%), 4 list lines (20%), 6 code lines
 * incl. fences (30%), 3 blank lines (15%). One of the prose lines is a wiki-link
 * paragraph (atom-node coverage) — included in the prose share.
 */
export function generateMarkdown(lineCount: number, options: GenerateMarkdownOptions = {}): string {
  const { unicode = false, noTrailingNewline = false } = options;
  const lines: string[] = [];
  const BLOCK_SIZE = 20;

  for (let i = 0; i < lineCount; i++) {
    const blockIdx = Math.floor(i / BLOCK_SIZE);
    const posInBlock = i % BLOCK_SIZE;

    switch (posInBlock) {
      case 0:
        lines.push(`## Section ${blockIdx + 1} — ${sentence(i, 4, unicode)}`);
        break;
      case 1:
      case 2:
      case 3:
      case 4:
        lines.push(`${sentence(i, 10, unicode)}.`);
        break;
      case 5:
      case 10:
      case 17:
        lines.push('');
        break;
      case 6:
      case 7:
      case 8:
      case 9:
        lines.push(`- ${sentence(i, 6, unicode)}`);
        break;
      case 11:
        lines.push('```typescript');
        break;
      case 12:
      case 13:
      case 14:
      case 15:
        lines.push(`const val_${i} = "${sentence(i, 3, unicode)}";`);
        break;
      case 16:
        lines.push('```');
        break;
      case 18:
        if (unicode) {
          lines.push(`See [[页面-${blockIdx}#セクション|エイリアス]] ${sentence(i, 5, unicode)}.`);
        } else {
          lines.push(
            `See [[page-${blockIdx}#section|Alias ${blockIdx}]] ${sentence(i, 5, unicode)}.`,
          );
        }
        break;
      case 19:
        lines.push(`${sentence(i, 8, unicode)}.`);
        break;
      default:
        lines.push(`${sentence(i, 8, unicode)}.`);
    }
  }

  const content = lines.join('\n');
  return noTrailingNewline ? content : `${content}\n`;
}
