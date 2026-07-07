/**
 * Lift a database row page's `Key: Value` property block into YAML
 * frontmatter.
 *
 * Notion exports each database-row page as `# Title` followed by a contiguous
 * block of `Key: Value` lines (its column values), then the page body. Those
 * land as plain body text, so OK's Properties panel never sees them. We move the
 * block to a leading frontmatter block. The set of real property keys is the
 * database's `_all.csv` header — passed in so body prose that merely looks like
 * `Word: text` is never captured.
 *
 * Values are emitted as lossless scalars (quoted when needed). Comma-joined
 * multi-select values stay quoted scalars rather than being split into YAML
 * lists: the Markdown export is ambiguous between a multi-select and prose with
 * commas, and splitting would corrupt the latter. Idempotent: a file that
 * already starts with frontmatter is returned unchanged.
 */

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/;
// YAML 1.2 core-schema tokens that a bare scalar would re-parse as a non-string
// (boolean / null / number). Notion values are text, so these must stay quoted
// to preserve their type — a text `true` or `1234` must not become a bool/number.
const YAML_TYPED = /^(true|false|null|~)$/i;
const YAML_NUMERIC =
  /^[-+]?(\.\d+|\d+(\.\d*)?([eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i;

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Emit a YAML scalar (key or value), quoting when not plainly safe. */
function yamlScalar(value: string): string {
  if (value === '') return '""';
  if (YAML_TYPED.test(value) || YAML_NUMERIC.test(value)) return quote(value);
  if (PLAIN.test(value)) return value;
  return quote(value);
}

function propertyLine(key: string, value: string): string {
  const k = PLAIN.test(key) ? key : quote(key);
  return value.trimEnd() === '' ? `${k}:` : `${k}: ${yamlScalar(value.trimEnd())}`;
}

export function propertiesToFrontmatter(
  markdown: string,
  propertyKeys: ReadonlySet<string>,
): string {
  if (propertyKeys.size === 0) return markdown;
  if (/^---\r?\n/.test(markdown)) return markdown; // already has frontmatter

  const lines = markdown.split('\n');

  // Find the H1; bail if any non-blank content precedes it.
  let h1 = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i] as string)) {
      h1 = i;
      break;
    }
    if ((lines[i] as string).trim() !== '') return markdown;
  }
  if (h1 === -1) return markdown;

  // Skip blank lines, then collect the contiguous property block.
  let i = h1 + 1;
  while (i < lines.length && (lines[i] as string).trim() === '') i++;
  const props: Array<[string, string]> = [];
  while (i < lines.length) {
    const match = (lines[i] as string).match(/^([^:]+):\s?(.*)$/);
    if (!match) break;
    const key = (match[1] as string).trim();
    if (!propertyKeys.has(key)) break;
    props.push([key, match[2] as string]);
    i++;
  }
  if (props.length === 0) return markdown;

  const bodyAfter = lines.slice(i);
  while (bodyAfter.length > 0 && (bodyAfter[0] as string).trim() === '') bodyAfter.shift();

  const parts: string[] = [
    '---',
    ...props.map(([k, v]) => propertyLine(k, v)),
    '---',
    '',
    lines[h1] as string,
  ];
  if (bodyAfter.length > 0) parts.push('', ...bodyAfter);

  // `bodyAfter` may carry the trailing empty element from the final newline;
  // normalize the tail so we don't emit a doubled newline.
  const result = parts.join('\n').replace(/\n+$/, '');
  return markdown.endsWith('\n') ? `${result}\n` : result;
}
