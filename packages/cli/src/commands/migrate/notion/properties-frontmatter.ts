const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/;
const YAML_TYPED = /^(true|false|null|~)$/i;
const YAML_NUMERIC =
  /^[-+]?(\.\d+|\d+(\.\d*)?([eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i;

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

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
  if (/^---\r?\n/.test(markdown)) return markdown;

  const lines = markdown.split('\n');

  let h1 = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i] as string)) {
      h1 = i;
      break;
    }
    if ((lines[i] as string).trim() !== '') return markdown;
  }
  if (h1 === -1) return markdown;

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

  const result = parts.join('\n').replace(/\n+$/, '');
  return markdown.endsWith('\n') ? `${result}\n` : result;
}
