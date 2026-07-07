#!/usr/bin/env bun
// Reads tmp/strings-audit/catalog.json and flags strings that look like title-case
// violations of the sentence-case rule. Allowlists brand, product names, and acronyms.
// Outputs casing-violations.json + a readable console report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..', '..');
const OUT_DIR = resolve(APP_ROOT, 'tmp', 'strings-audit');
const CATALOG_PATH = join(OUT_DIR, 'catalog.json');
const OUT_PATH = join(OUT_DIR, 'casing-violations.json');

// Words allowed to retain a capital when they appear at position ≥1.
// Three buckets: brand tokens, product names, common dev-tool nouns.
const PROPER_NOUNS = new Set([
  // OpenKnowledge brand
  'Knowledge',
  'OK',
  'Inkeep',
  // Agent / product names
  'Claude',
  'Codex',
  'Cursor',
  'Windsurf',
  'ChatGPT',
  'GPT',
  'OpenAI',
  'Anthropic',
  // Code-host / dev-tool brands
  'GitHub',
  'GitLab',
  'Bitbucket',
  // Note: `Code` is NOT a proper noun on its own — bare "Code" is a generic
  // English word and would let "Run this Code" pass the check. "VS Code" /
  // "Claude Code" are covered by the BRAND_PHRASES span mechanism instead.
  // `VS` stays because it's all-caps (acronym shape) and isn't a real English
  // word that would appear mid-sentence.
  'VS',
  'TipTap',
  'Tiptap',
  'CodeMirror',
  'ProseMirror',
  'Hocuspocus',
  'Electron',
  'Yjs',
  'Bun',
  'Node',
  'React',
  'TypeScript',
  'JavaScript',
  'CommonMark',
  'Markdown',
  // OS / platforms
  'macOS',
  'iOS',
  'iPadOS',
  'Linux',
  'Windows',
  'Android',
  // Other apps OK integrates with. Note: `Bear` is the macOS notes app, but
  // it's also a common English noun and would let "Bear with me" pass — when
  // it lands on disk as a feature reference, add the specific phrase to
  // BRAND_PHRASES (e.g. "Bear app") rather than allowing the bare token.
  'Obsidian',
  'Notion',
  'Logseq',
  // macOS system apps / surfaces (Apple HIG capitalizes these in UI)
  'Finder',
  'Terminal',
  'Trash',
  'Dock',
  'Spotlight',
  // External products / brands. Bare `Chat` is intentionally NOT here — it's
  // a common English word and "Open Chat" would slip through. Real references
  // to Anthropic's Chat surface come paired with "Claude" or "Cowork" and are
  // covered by BRAND_PHRASES.
  'Copilot', // GitHub Copilot
  'Twitter',
  'Cowork', // Coined Inkeep / Claude term; safe as a bare proper noun.
  // Keyboard keys (UI convention: capitalize)
  'Escape',
  'Esc',
  'Enter',
  'Return',
  'Shift',
  'Tab',
  'Cmd',
  'Ctrl',
  'Alt',
  // First-word capital — already allowed at position 0; need not be here.
]);

// Brand phrases — multi-word proper-noun compounds. When a value contains one of
// these phrases, every token inside the phrase is treated as allowed (even though
// "Open" or "Knowledge" alone wouldn't pass the PROPER_NOUNS check).
const BRAND_PHRASES: string[] = [
  'OpenKnowledge',
  'Claude Code',
  'Claude Desktop',
  'Claude Skill',
  'Claude Skills',
  'Claude Chat',
  'Chat & Cowork',
  'Chat and Cowork',
  'VS Code',
  'GitHub Copilot',
  'Reveal in Finder',
  'Move to Trash',
];

// Strings that are clearly NOT user-facing prose: code/identifiers/file extensions.
// Skip casing check on them (false-positive control).
function isProseCandidate(value: string): boolean {
  // Measure against the trimmed form — JSX text often arrives with surrounding
  // indentation/newlines that would otherwise tank the letter-ratio check.
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) || []).length;
  if (letters / trimmed.length < 0.5) return false;
  if (value.includes('${...}')) return false;
  if (/_/.test(trimmed) && tokens.length === 1) return false;
  return true;
}

// Acronym: 2-5 uppercase letters, all-caps.
function isAcronym(word: string): boolean {
  return /^[A-Z]{2,5}$/.test(word);
}

// Internal-cap brand pattern: like "GitHub" (lowercase then uppercase),
// "macOS" (camelCase brand), "TipTap" (multi-cap).
function hasInternalCap(word: string): boolean {
  return /[a-z][A-Z]/.test(word) || /^[A-Z][a-z]+[A-Z]/.test(word);
}

function isWordAllowed(word: string): boolean {
  if (PROPER_NOUNS.has(word)) return true;
  if (isAcronym(word)) return true;
  if (hasInternalCap(word)) return true;
  // Hyphenated compounds (e.g. "AI-readable", "Open-source") — allow if any
  // hyphen-segment is itself an acronym or proper noun.
  if (word.includes('-')) {
    const parts = word.split('-');
    if (parts.some((p) => PROPER_NOUNS.has(p) || isAcronym(p) || hasInternalCap(p))) return true;
  }
  return false;
}

// A separator run resets sentence-case expectations if it contains terminal
// punctuation or a line break — this handles multi-line UI copy where "Examples:"
// follows ".\n# " or similar.
function separatorEndsClause(sep: string): boolean {
  return /[.!?:]/.test(sep) || /\n/.test(sep);
}

// Locate every span in `value` covered by a brand phrase. Words whose start index
// falls inside any span are treated as allowed.
function findBrandSpans(value: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const phrase of BRAND_PHRASES) {
    let idx = 0;
    while ((idx = value.indexOf(phrase, idx)) !== -1) {
      spans.push([idx, idx + phrase.length]);
      idx += phrase.length;
    }
  }
  return spans;
}

function isInBrandSpan(pos: number, spans: Array<[number, number]>): boolean {
  for (const [s, e] of spans) {
    if (pos >= s && pos < e) return true;
  }
  return false;
}

type Violation = {
  badWords: string[]; // tokens that are capitalized but shouldn't be
  suggested: string;
};

function checkSentenceCase(value: string): Violation | null {
  if (!isProseCandidate(value)) return null;

  const brandSpans = findBrandSpans(value);

  // Tokenize while preserving separators + index so we can spot brand-span overlap.
  const tokenRegex = /([A-Za-z][A-Za-z'-]*)|([^A-Za-z]+)/g;
  const parts: Array<{ word?: string; sep?: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(value)) !== null) {
    if (m[1]) parts.push({ word: m[1], index: m.index });
    else parts.push({ sep: m[2], index: m.index });
  }

  const badWords: string[] = [];
  let sawFirstWord = false;
  let prevSep = '';
  const rebuilt: string[] = [];

  for (const p of parts) {
    if (p.sep !== undefined) {
      rebuilt.push(p.sep);
      prevSep = p.sep;
      continue;
    }
    const word = p.word!;
    const isCap = /^[A-Z]/.test(word);
    if (!sawFirstWord) {
      rebuilt.push(word);
      sawFirstWord = true;
      prevSep = '';
      continue;
    }
    if (separatorEndsClause(prevSep)) {
      rebuilt.push(word);
      prevSep = '';
      continue;
    }
    if (!isCap) {
      rebuilt.push(word);
      prevSep = '';
      continue;
    }
    if (isInBrandSpan(p.index, brandSpans)) {
      rebuilt.push(word);
      prevSep = '';
      continue;
    }
    if (isWordAllowed(word)) {
      rebuilt.push(word);
      prevSep = '';
      continue;
    }
    badWords.push(word);
    rebuilt.push(word[0]!.toLowerCase() + word.slice(1));
    prevSep = '';
  }

  if (!badWords.length) return null;
  return { badWords, suggested: rebuilt.join('') };
}

// Load catalog. The checker runs against extract.ts's output; bail with a
// clear instruction rather than letting fs throw a raw ENOENT trace.
if (!existsSync(CATALOG_PATH)) {
  console.error(
    `[audit-strings:casing] catalog.json not found at ${CATALOG_PATH}.\n` +
      `Run \`bun run audit:strings\` first to generate it, then re-run this command.`,
  );
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

type CatalogString = {
  value: string;
  displayValue: string;
  occurrenceCount: number;
  uniqueViewCount: number;
  views: string[];
  charCount: number;
  hasTemplate: boolean;
  occurrences: Array<{
    file: string;
    line: number;
    column: number;
    view: string;
    kind: string;
    attr?: string;
    callee?: string;
    componentContext?: string;
  }>;
};

const violations: Array<{
  value: string;
  suggested: string;
  badWords: string[];
  occurrenceCount: number;
  uniqueViewCount: number;
  views: string[];
  occurrences: CatalogString['occurrences'];
}> = [];

for (const s of catalog.strings as CatalogString[]) {
  const v = checkSentenceCase(s.displayValue);
  if (!v) continue;
  violations.push({
    value: s.displayValue,
    suggested: v.suggested,
    badWords: v.badWords,
    occurrenceCount: s.occurrenceCount,
    uniqueViewCount: s.uniqueViewCount,
    views: s.views,
    occurrences: s.occurrences,
  });
}

// Sort by occurrence count, then alphabetical
violations.sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.value.localeCompare(b.value));

// Console report
console.error(`
=== sentence-case violations ===
unique violators:   ${violations.length}
total occurrences:  ${violations.reduce((n, v) => n + v.occurrenceCount, 0)}

Allowlisted proper nouns (${PROPER_NOUNS.size}): ${[...PROPER_NOUNS].slice(0, 25).join(', ')}${PROPER_NOUNS.size > 25 ? '…' : ''}
`);

for (const v of violations) {
  const bad = v.badWords.join(', ');
  console.error(
    `× ${v.occurrenceCount}  ${JSON.stringify(v.value)}  →  ${JSON.stringify(v.suggested)}    [bad: ${bad}]`,
  );
  for (const o of v.occurrences.slice(0, 6)) {
    const attr = o.attr ? `[${o.attr}] ` : o.callee ? `[${o.callee}] ` : '';
    const cmp = o.componentContext ? ` in ${o.componentContext}` : '';
    console.error(`        ${attr}${o.file}:${o.line}:${o.column}${cmp}  · ${o.view}`);
  }
  if (v.occurrences.length > 6) console.error(`        … +${v.occurrences.length - 6} more`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_PATH,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: 'catalog.json',
      properNounAllowlist: [...PROPER_NOUNS].sort(),
      brandPhrases: [...BRAND_PHRASES].sort(),
      violationCount: violations.length,
      totalOccurrences: violations.reduce((n, v) => n + v.occurrenceCount, 0),
      violations,
    },
    null,
    2,
  ),
);
console.error(`\nwrote ${OUT_PATH}`);
