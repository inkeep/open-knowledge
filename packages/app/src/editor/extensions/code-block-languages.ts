interface CodeLanguageOption {
  value: string;
  label: string;
  aliases?: string[];
}

export const CODE_BLOCK_LANGUAGES: CodeLanguageOption[] = [
  { value: 'plaintext', label: 'Plain text', aliases: ['text', 'txt', 'none'] },
  { value: 'bash', label: 'Bash', aliases: ['sh', 'zsh'] },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++', aliases: ['c++'] },
  { value: 'csharp', label: 'C#', aliases: ['cs'] },
  { value: 'css', label: 'CSS' },
  { value: 'diff', label: 'Diff', aliases: ['patch'] },
  { value: 'go', label: 'Go', aliases: ['golang'] },
  { value: 'graphql', label: 'GraphQL', aliases: ['gql'] },
  { value: 'ini', label: 'INI', aliases: ['toml'] },
  { value: 'java', label: 'Java' },
  { value: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'mjs', 'cjs'] },
  { value: 'json', label: 'JSON', aliases: ['jsonc'] },
  { value: 'kotlin', label: 'Kotlin', aliases: ['kt'] },
  { value: 'less', label: 'Less' },
  { value: 'lua', label: 'Lua' },
  { value: 'makefile', label: 'Makefile', aliases: ['make'] },
  { value: 'markdown', label: 'Markdown', aliases: ['md', 'mdx'] },
  { value: 'objectivec', label: 'Objective-C', aliases: ['objc', 'obj-c'] },
  { value: 'perl', label: 'Perl', aliases: ['pl'] },
  { value: 'php', label: 'PHP' },
  { value: 'python', label: 'Python', aliases: ['py'] },
  { value: 'r', label: 'R' },
  { value: 'ruby', label: 'Ruby', aliases: ['rb'] },
  { value: 'rust', label: 'Rust', aliases: ['rs'] },
  { value: 'scss', label: 'SCSS', aliases: ['sass'] },
  { value: 'shell', label: 'Shell session', aliases: ['console', 'shellsession'] },
  { value: 'sql', label: 'SQL' },
  { value: 'swift', label: 'Swift' },
  { value: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx'] },
  { value: 'xml', label: 'XML / HTML', aliases: ['html', 'htm', 'svg'] },
  { value: 'yaml', label: 'YAML', aliases: ['yml'] },
];

const ALIAS_MAP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const lang of CODE_BLOCK_LANGUAGES) {
    m.set(lang.value, lang.value);
    for (const alias of lang.aliases ?? []) m.set(alias, lang.value);
  }
  return m;
})();

export function normalizeCodeLanguage(language: string | null | undefined): string | null {
  if (!language) return null;
  return ALIAS_MAP.get(language.toLowerCase()) ?? language.toLowerCase();
}
