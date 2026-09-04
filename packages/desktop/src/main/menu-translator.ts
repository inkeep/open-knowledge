export type MenuTranslator = (message: string, values?: Record<string, string>) => string;

export function translateEnglish(message: string, values?: Record<string, string>): string {
  if (values === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
