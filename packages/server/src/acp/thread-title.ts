export const TITLE_MAX_CHARS = 48;

const FILLER_PREFIXES = [
  'do you mind',
  'i would like you to',
  "i'd like you to",
  'i want you to',
  'i need you to',
  'i would like to',
  "i'd like to",
  'i want to',
  'i need to',
  'we need to',
  'we want to',
  'we should',
  'go ahead and',
  'take a look at',
  'have a look at',
  'look into',
  'look at',
  'help me with',
  'help me to',
  'help me',
  'can you',
  'could you',
  'would you',
  'will you',
  'can we',
  'could we',
  'should we',
  "let's",
  'lets',
  'try to',
  'please',
  'kindly',
  'hello',
  'alright',
  'actually',
  'anyway',
  'also',
  'okay',
  'hey',
  'hi',
  'yo',
  'ok',
  'so',
  'pls',
  'plz',
  'just',
  'maybe',
];

const FILLER_RE = new RegExp(
  `^(?:${FILLER_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b(?:[\\s,:;!.\\-–—]+|$)`,
  'i',
);

const MARKDOWN_LEAD_RE = /^(?:[#>]+\s*|[-*]\s+|\d+[.)]\s+)+/;

const LEADING_PUNCT_RE = /^[\s,:;.!?\-–—•|]+(?=\s|$)/;

const MAX_STRIP_PASSES = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstLine(raw: string): string {
  return (raw.trim().split('\n')[0] ?? '').trim();
}

export function clampThreadTitle(raw: string): string {
  const line = firstLine(raw);
  if (line.length <= TITLE_MAX_CHARS) return line;
  const hard = line.slice(0, TITLE_MAX_CHARS - 1);
  const lastSpace = hard.lastIndexOf(' ');
  const cut = lastSpace >= TITLE_MAX_CHARS / 2 ? hard.slice(0, lastSpace) : hard;
  return `${cut.trimEnd()}…`;
}

export function deriveThreadTitle(prompt: string, agentName?: string): string {
  const line = firstLine(prompt);
  let stripped = line.replace(MARKDOWN_LEAD_RE, '');
  if (agentName !== undefined && agentName.trim() !== '') {
    const name = escapeRegExp(agentName.trim());
    const delim = String.raw`[,:;!.?\-–—•|]`;
    const nameRe = new RegExp(
      `^(?:@${name}\\b(?:\\s+|${delim}+(?:\\s+|$)|$)|${name}\\b\\s*${delim}+(?:\\s+|$)|@?${name}\\b$)`,
      'i',
    );
    stripped = stripped.replace(nameRe, '');
  }
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = stripped.replace(FILLER_RE, '');
    if (next === stripped) break;
    stripped = next;
  }
  stripped = stripped.replace(LEADING_PUNCT_RE, '').trim();
  const words = stripped.split(/\s+/).filter((w) => w !== '').length;
  const viable = stripped !== '' && (words >= 2 || stripped.length >= 12);
  if (!viable || stripped === line) return clampThreadTitle(line);
  return clampThreadTitle(stripped.charAt(0).toUpperCase() + stripped.slice(1));
}
