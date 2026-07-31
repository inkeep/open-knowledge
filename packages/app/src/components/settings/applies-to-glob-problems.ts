/**
 * Parses the config channel's `appliesTo` glob problems back into their parts
 * so each one can be shown on the glob it belongs to, rather than in a flat
 * list that names the pattern but not which input produced it.
 *
 * The wire shape is composed in the server's `lint/frontmatter-schemas.ts`:
 *
 *   <kind> appliesTo glob "<pattern>" — <detail> (frontmatter mapping for <file>)
 *
 * where `<pattern>` is `JSON.stringify`d. That string is the compose contract
 * between the two files — keep in sync on either-side change. A shape this
 * parser doesn't recognize returns null and stays in the flat list, so a
 * server-side wording change degrades to the old surface instead of silently
 * dropping the problem.
 */

const KINDS = ['unmatched', 'invalid', 'suspicious'] as const;

type AppliesToGlobProblemKind = (typeof KINDS)[number];

export interface AppliesToGlobProblem {
  kind: AppliesToGlobProblemKind;
  /** The authored pattern, unquoted — matches the pill's value verbatim. */
  pattern: string;
  /** Why it's a problem, without the kind prefix or the mapping suffix. */
  detail: string;
  /** Schema file whose mapping carries the pattern. */
  file: string;
}

const GLOB_MARKER = ' appliesTo glob ';
const MAPPING_MARKER = ' (frontmatter mapping for ';
const DETAIL_SEPARATOR = ' — ';

/** Reads the leading `"..."` off `text`, honoring JSON escapes. */
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

  // The mapping suffix is matched from the right: a detail can legitimately
  // contain parentheses, but the suffix is always last.
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

/**
 * Groups parseable glob problems as file → pattern → detail. Several problems
 * can name one pattern (invalid and unmatched both fire on a bad glob); the
 * details join so the pill's tooltip reports all of them.
 */
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
