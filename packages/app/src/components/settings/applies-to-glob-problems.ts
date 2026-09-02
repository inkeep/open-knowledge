const KINDS = ['unmatched', 'invalid', 'suspicious'] as const;

type AppliesToGlobProblemKind = (typeof KINDS)[number];

export interface AppliesToGlobProblem {
  kind: AppliesToGlobProblemKind;
  pattern: string;
  detail: string;
  file: string;
}

const GLOB_MARKER = ' appliesTo glob ';
const MAPPING_MARKER = ' (frontmatter mapping for ';
const DETAIL_SEPARATOR = ' — ';

function readQuoted(text: string): { value: string; rest: string } | null {
  if (!text.startsWith('"')) return null;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch !== '"') continue;
    try {
      return { value: JSON.parse(text.slice(0, i + 1)) as string, rest: text.slice(i + 1) };
    } catch {
      return null;
    }
  }
  return null;
}

export function parseAppliesToGlobProblem(problem: string): AppliesToGlobProblem | null {
  const kind = KINDS.find((k) => problem.startsWith(`${k}${GLOB_MARKER}`));
  if (kind === undefined) return null;

  const quoted = readQuoted(problem.slice(kind.length + GLOB_MARKER.length));
  if (quoted === null) return null;

  const suffixAt = quoted.rest.lastIndexOf(MAPPING_MARKER);
  if (suffixAt === -1 || !quoted.rest.endsWith(')')) return null;
  const file = quoted.rest.slice(suffixAt + MAPPING_MARKER.length, -1);
  if (file === '') return null;

  const middle = quoted.rest.slice(0, suffixAt);
  if (!middle.startsWith(DETAIL_SEPARATOR)) return null;
  const detail = middle.slice(DETAIL_SEPARATOR.length);
  if (detail === '') return null;

  return { kind, pattern: quoted.value, detail, file };
}

export function indexGlobProblemsByFile(
  problems: readonly string[],
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const byFile = new Map<string, Map<string, string>>();
  for (const problem of problems) {
    const parsed = parseAppliesToGlobProblem(problem);
    if (parsed === null) continue;
    let byPattern = byFile.get(parsed.file);
    if (byPattern === undefined) {
      byPattern = new Map<string, string>();
      byFile.set(parsed.file, byPattern);
    }
    const existing = byPattern.get(parsed.pattern);
    byPattern.set(
      parsed.pattern,
      existing === undefined ? parsed.detail : `${existing}; ${parsed.detail}`,
    );
  }
  return byFile;
}
