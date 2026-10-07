export function renderLinguiTemplate(
  strings: TemplateStringsArray | string | { message: string },
  ...values: unknown[]
): string {
  if (typeof strings === 'string') return strings;
  if ('message' in strings) return strings.message;
  return strings.reduce(
    (text, chunk, index) => `${text}${chunk}${index < values.length ? String(values[index]) : ''}`,
    '',
  );
}
