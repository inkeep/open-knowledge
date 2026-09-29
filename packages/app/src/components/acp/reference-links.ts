export interface AutolinkEntry {
  readonly prefix: string;
  readonly url: string;
}

export interface ReferenceRulesInput {
  readonly githubBase: string;
  readonly autolinks: readonly AutolinkEntry[];
}

interface ReferenceRule {
  readonly pattern: RegExp;
  readonly href: (match: RegExpExecArray) => string;
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastNode[];
}

const DEFAULT_GITHUB_BASE = 'https://github.com';

const GITHUB_REFERENCE =
  /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#(\d{1,10})\b/g;

const LEAVE_ALONE: ReadonlySet<string> = new Set(['link', 'linkReference', 'definition']);

export function githubWebBase(remoteWebUrl: string | null | undefined): string {
  if (remoteWebUrl === null || remoteWebUrl === undefined || remoteWebUrl === '') {
    return DEFAULT_GITHUB_BASE;
  }
  let url: URL;
  try {
    url = new URL(remoteWebUrl);
  } catch {
    return DEFAULT_GITHUB_BASE;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_GITHUB_BASE;
  return `${url.protocol}//${url.host}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

function buildReferenceRules(input: ReferenceRulesInput): ReferenceRule[] {
  const rules: ReferenceRule[] = [
    {
      pattern: GITHUB_REFERENCE,
      href: (m) => `${input.githubBase}/${m[1]}/${m[2]}/issues/${m[3]}`,
    },
  ];
  for (const entry of input.autolinks) {
    if (entry.prefix === '' || !entry.url.includes('<num>')) continue;
    rules.push({
      pattern: new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(entry.prefix)}(\\d{1,10})\\b`, 'g'),
      href: (m) => entry.url.replaceAll('<num>', m[1] ?? ''),
    });
  }
  return rules;
}

export function referenceRulesKey(input: ReferenceRulesInput | null): string {
  if (input === null) return '';
  return JSON.stringify([input.githubBase, input.autolinks.map((a) => [a.prefix, a.url])]);
}

export function remarkReferenceLinks(input: ReferenceRulesInput | null) {
  const rules = input === null ? [] : buildReferenceRules(input);
  return (tree: MdastNode): void => {
    if (rules.length === 0) return;
    try {
      rewriteNode(tree, rules);
    } catch (err) {
      console.warn('[remarkReferenceLinks] rewrite failed, partial rewrites may remain', err);
    }
  };
}

function rewriteNode(node: MdastNode, rules: readonly ReferenceRule[]): void {
  const children = node.children;
  if (children === undefined) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child === undefined || child === null) continue;
    if (LEAVE_ALONE.has(child.type)) {
      next.push(child);
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...splitText(child.value, rules));
      continue;
    }
    rewriteNode(child, rules);
    next.push(child);
  }
  node.children = next;
}

interface Found {
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

function splitText(value: string, rules: readonly ReferenceRule[]): MdastNode[] {
  const found: Found[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match = pattern.exec(value);
    while (match !== null) {
      found.push({ start: match.index, end: match.index + match[0].length, url: rule.href(match) });
      match = pattern.exec(value);
    }
  }
  if (found.length === 0) return [{ type: 'text', value }];
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: MdastNode[] = [];
  let cursor = 0;
  for (const hit of found) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) out.push({ type: 'text', value: value.slice(cursor, hit.start) });
    out.push({
      type: 'link',
      url: hit.url,
      title: null,
      children: [{ type: 'text', value: value.slice(hit.start, hit.end) }],
    });
    cursor = hit.end;
  }
  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) });
  return out;
}
