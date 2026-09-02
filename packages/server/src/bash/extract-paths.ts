import type { Stage } from './parse-command.ts';

const PRODUCER_COMMANDS: ReadonlySet<string> = new Set(['cat', 'ls', 'grep', 'find']);

const PATH_FALLBACK_RE = /\b[\w./-]+\.(md|mdx)\b/g;

function isWikiPath(p: string): boolean {
  return /\.(md|mdx)$/.test(p);
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

export function nonFlagArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}

function extractFromCat(stage: Stage): string[] {
  return nonFlagArgs(argsOf(stage)).filter(isWikiPath);
}

function extractFromLs(stdout: string, stage: Stage): string[] {
  const pathArgs = nonFlagArgs(argsOf(stage));
  const baseDir = pathArgs.length > 0 ? pathArgs[pathArgs.length - 1] : '';
  const prefix = baseDir && baseDir !== '.' ? normalize(baseDir) : '';
  const out: string[] = [];
  if (prefix) out.push(prefix);
  for (const line of stdout.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    if (/\.[a-z0-9]+$/i.test(name) && !isWikiPath(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    out.push(path);
  }
  return out;
}

function extractFromGrep(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const firstColon = line.indexOf(':');
    if (firstColon < 0) continue;
    const path = normalize(line.slice(0, firstColon));
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
  return nonFlagArgs(argsOf(stage)).filter(isWikiPath);
}

function headTailActsAsProducer(stage: Stage): boolean {
  return nonFlagArgs(argsOf(stage)).length > 0;
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
    if ((s.command === 'head' || s.command === 'tail') && headTailActsAsProducer(s)) {
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
        raw = extractFromCat(producer);
        break;
      case 'ls':
        raw = extractFromLs(stdout, producer);
        break;
      case 'grep':
        raw = extractFromGrep(stdout);
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
