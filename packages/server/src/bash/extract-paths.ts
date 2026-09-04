import { classifyArgs, isRecursiveGrepFlag, type Stage } from './parse-command.ts';

const PRODUCER_COMMANDS: ReadonlySet<string> = new Set(['cat', 'ls', 'find']);

const OPERAND_COMMANDS: ReadonlySet<string> = new Set(['sort', 'uniq', 'cut', 'wc']);

function operandCommandActsAsProducer(stage: Stage): boolean {
  return OPERAND_COMMANDS.has(stage.command) && pathArgs(stage).some(isWikiPath);
}

const PATH_FALLBACK_RE = /\b[\w./-]+\.(md|mdx)\b/gi;

export function isWikiPath(p: string): boolean {
  return /\.(md|mdx)$/i.test(p);
}

function normalize(p: string): string {
  let out = p.trim();
  if (!out) return '';
  out = out.replace(/\/+/g, '/');
  if (out.startsWith('./')) out = out.slice(2);
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function argsOf(stage: Stage): string[] {
  return stage.args.slice(1);
}

export function pathArgs(stage: Stage): string[] {
  return classifyArgs(stage)
    .filter((a) => a.role === 'path')
    .map((a) => a.value);
}

function extractFromCat(stage: Stage): string[] {
  return pathArgs(stage).filter(isWikiPath);
}

const LS_LONG_RE = /^[bcdlprsw-][rwxsStT-]{9}[.+@]?\s+(?:\S+\s+){7}(.+)$/;

function lsEntryName(line: string): string {
  const trimmed = line.trim();
  const long = LS_LONG_RE.exec(trimmed);
  return long ? long[1] : trimmed;
}

function extractFromLs(stdout: string, stage: Stage): string[] {
  const operands = pathArgs(stage);
  const fileArgs = operands.filter(isWikiPath);
  if (operands.length > 0 && fileArgs.length === operands.length) {
    return fileArgs.map((p) => normalize(p));
  }
  const only = operands.length === 1 ? operands[0] : '';
  let prefix = only && only !== '.' ? normalize(only) : '';
  const out: string[] = [];
  if (prefix) out.push(prefix);
  for (const line of stdout.split('\n')) {
    const name = lsEntryName(line);
    if (!name || name === '.' || name === '..' || /^total \d+$/.test(name)) continue;
    if (name.endsWith(':')) {
      const dir = normalize(name.slice(0, -1));
      prefix = dir === '.' ? '' : dir;
      if (prefix) out.push(prefix);
      continue;
    }
    if (/\.[a-z0-9]+$/i.test(name) && !isWikiPath(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    out.push(path);
  }
  return out;
}

function searchOperands(stage: Stage): string[] {
  return classifyArgs(stage)
    .filter((a) => a.role === 'path' && a.flag === undefined && a.value !== '-')
    .map((a) => a.value);
}

function grepHasFlag(stage: Stage, letter: string, long: string): boolean {
  return classifyArgs(stage).some(
    (a) =>
      a.role === 'flag' &&
      (a.value === long || (/^-[a-zA-Z]+\d*$/.test(a.value) && a.value.includes(letter))),
  );
}

function grepPrintsFilenamesOnly(stage: Stage): boolean {
  return (
    grepHasFlag(stage, 'l', '--files-with-matches') ||
    grepHasFlag(stage, 'L', '--files-without-match')
  );
}

function grepIsRecursive(stage: Stage): boolean {
  return classifyArgs(stage).some((a) => a.role === 'flag' && isRecursiveGrepFlag(a.value));
}

function grepPrefixesFilenames(stage: Stage): boolean {
  if (grepHasFlag(stage, 'h', '--no-filename')) return false;
  return searchOperands(stage).length > 1 || grepIsRecursive(stage);
}

function grepActsAsProducer(stage: Stage): boolean {
  return searchOperands(stage).length > 0;
}

function extractFromGrep(stdout: string, stage: Stage): string[] {
  const filenamesOnly = grepPrintsFilenamesOnly(stage);
  if (!filenamesOnly && !grepPrefixesFilenames(stage)) {
    return searchOperands(stage).filter(isWikiPath).map(normalize);
  }
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const end = filenamesOnly ? line.length : line.indexOf(':');
    if (end < 0) continue;
    const path = normalize(line.slice(0, end));
    if (isWikiPath(path)) out.push(path);
  }
  return out;
}

function extractFromFind(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const path = normalize(line);
    if (!path) continue;
    if (isWikiPath(path)) out.push(path);
  }
  return out;
}

function extractFromHeadTail(stage: Stage): string[] {
  return pathArgs(stage).filter(isWikiPath);
}

function headTailActsAsProducer(stage: Stage): boolean {
  return pathArgs(stage).some(isWikiPath);
}

function fallback(stdout: string): string[] {
  const out: string[] = [];
  const matches = stdout.matchAll(PATH_FALLBACK_RE);
  for (const m of matches) out.push(normalize(m[0]));
  return out;
}

export function extractReferencedPaths(stdout: string, stages: Stage[]): string[] {
  let producer: Stage | null = null;
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i];
    if (PRODUCER_COMMANDS.has(s.command)) {
      producer = s;
      break;
    }
    if (s.command === 'grep' && grepActsAsProducer(s)) {
      producer = s;
      break;
    }
    if ((s.command === 'head' || s.command === 'tail') && headTailActsAsProducer(s)) {
      producer = s;
      break;
    }
    if (operandCommandActsAsProducer(s)) {
      producer = s;
      break;
    }
  }

  let raw: string[];
  if (!producer) {
    raw = fallback(stdout);
  } else {
    switch (producer.command) {
      case 'cat':
      case 'sort':
      case 'uniq':
      case 'cut':
      case 'wc':
        raw = extractFromCat(producer);
        break;
      case 'ls':
        raw = extractFromLs(stdout, producer);
        break;
      case 'grep':
        raw = extractFromGrep(stdout, producer);
        break;
      case 'find':
        raw = extractFromFind(stdout);
        break;
      case 'head':
      case 'tail':
        raw = extractFromHeadTail(producer);
        break;
      default:
        raw = fallback(stdout);
    }
    if (raw.length === 0) {
      raw = fallback(stdout);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    const n = normalize(p);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
