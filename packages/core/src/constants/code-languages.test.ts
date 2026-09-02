import { describe, expect, test } from 'vitest';
import {
  CODE_FILE_BARE_NAMES_TO_LANGUAGE,
  CODE_FILE_EXTENSIONS,
  CODE_FILE_EXTENSIONS_TO_LANGUAGE,
  codeLanguageForBareFilename,
  codeLanguageForExtension,
  isEditableTextDocFile,
} from './code-languages';

describe('codeLanguageForExtension', () => {
  test('maps the canonical extensions to their codeblock language IDs', () => {
    expect(codeLanguageForExtension('ts')).toBe('typescript');
    expect(codeLanguageForExtension('tsx')).toBe('typescript');
    expect(codeLanguageForExtension('js')).toBe('javascript');
    expect(codeLanguageForExtension('py')).toBe('python');
    expect(codeLanguageForExtension('rs')).toBe('rust');
    expect(codeLanguageForExtension('go')).toBe('go');
    expect(codeLanguageForExtension('rb')).toBe('ruby');
    expect(codeLanguageForExtension('sh')).toBe('bash');
    expect(codeLanguageForExtension('cpp')).toBe('cpp');
    expect(codeLanguageForExtension('h')).toBe('c');
    expect(codeLanguageForExtension('hpp')).toBe('cpp');
    expect(codeLanguageForExtension('yaml')).toBe('yaml');
    expect(codeLanguageForExtension('xml')).toBe('xml');
    expect(codeLanguageForExtension('json')).toBe('json');
    expect(codeLanguageForExtension('feature')).toBe('gherkin');
    expect(codeLanguageForExtension('html')).toBeNull();
    expect(codeLanguageForExtension('htm')).toBeNull();
    expect(codeLanguageForExtension('svg')).toBeNull();
  });

  test('strips a leading dot from the extension input', () => {
    expect(codeLanguageForExtension('.ts')).toBe('typescript');
    expect(codeLanguageForExtension('.py')).toBe('python');
  });

  test('is case-insensitive', () => {
    expect(codeLanguageForExtension('TS')).toBe('typescript');
    expect(codeLanguageForExtension('PY')).toBe('python');
    expect(codeLanguageForExtension('Cpp')).toBe('cpp');
  });

  test('returns null for an unknown extension', () => {
    expect(codeLanguageForExtension('txt')).toBeNull();
    expect(codeLanguageForExtension('docx')).toBeNull();
    expect(codeLanguageForExtension('zip')).toBeNull();
    expect(codeLanguageForExtension('')).toBeNull();
  });

  test('aliases consolidate to the same canonical ID', () => {
    const javascriptAliases = ['js', 'jsx', 'mjs', 'cjs'];
    for (const alias of javascriptAliases) {
      expect(codeLanguageForExtension(alias)).toBe('javascript');
    }

    const typescriptAliases = ['ts', 'tsx'];
    for (const alias of typescriptAliases) {
      expect(codeLanguageForExtension(alias)).toBe('typescript');
    }

    const bashAliases = ['sh', 'zsh', 'bash'];
    for (const alias of bashAliases) {
      expect(codeLanguageForExtension(alias)).toBe('bash');
    }

    const jsonAliases = ['json', 'jsonc'];
    for (const alias of jsonAliases) {
      expect(codeLanguageForExtension(alias)).toBe('json');
    }
  });
});

describe('codeLanguageForBareFilename', () => {
  test('Makefile (any case) resolves to makefile', () => {
    expect(codeLanguageForBareFilename('Makefile')).toBe('makefile');
    expect(codeLanguageForBareFilename('makefile')).toBe('makefile');
    expect(codeLanguageForBareFilename('MAKEFILE')).toBe('makefile');
  });

  test('Dockerfile resolves to bash (shell-shaped commands)', () => {
    expect(codeLanguageForBareFilename('Dockerfile')).toBe('bash');
    expect(codeLanguageForBareFilename('dockerfile')).toBe('bash');
  });

  test('Gemfile / Rakefile resolve to ruby', () => {
    expect(codeLanguageForBareFilename('Gemfile')).toBe('ruby');
    expect(codeLanguageForBareFilename('Rakefile')).toBe('ruby');
  });

  test('returns null for an unrecognized bare filename', () => {
    expect(codeLanguageForBareFilename('README')).toBeNull();
    expect(codeLanguageForBareFilename('LICENSE')).toBeNull();
  });
});

describe('CODE_FILE_EXTENSIONS — internal consistency', () => {
  test('every extension key resolves through codeLanguageForExtension', () => {
    for (const ext of CODE_FILE_EXTENSIONS) {
      expect(codeLanguageForExtension(ext)).not.toBeNull();
    }
  });

  test('every canonical language ID is present in CODE_BLOCK_LANGUAGES', () => {
    const knownCanonical = new Set([
      'plaintext',
      'bash',
      'c',
      'cpp',
      'csharp',
      'css',
      'diff',
      'gherkin',
      'go',
      'graphql',
      'ini',
      'java',
      'javascript',
      'json',
      'kotlin',
      'less',
      'lua',
      'makefile',
      'markdown',
      'objectivec',
      'perl',
      'php',
      'python',
      'r',
      'ruby',
      'rust',
      'scss',
      'shell',
      'sql',
      'swift',
      'typescript',
      'xml',
      'yaml',
    ]);
    for (const lang of Object.values(CODE_FILE_EXTENSIONS_TO_LANGUAGE)) {
      expect(knownCanonical.has(lang)).toBe(true);
    }
    for (const lang of Object.values(CODE_FILE_BARE_NAMES_TO_LANGUAGE)) {
      expect(knownCanonical.has(lang)).toBe(true);
    }
  });
});

describe('isEditableTextDocFile', () => {
  test('admits code and plain-text extensions', () => {
    for (const path of [
      'src/util.ts',
      'a/b/config.json',
      'styles.css',
      'notes.txt',
      'settings.toml',
      'script.PY',
      'data.yaml',
    ]) {
      expect(isEditableTextDocFile(path), path).toBe(true);
    }
  });

  test('excludes the markdown and mermaid doc classes', () => {
    for (const path of ['readme.md', 'page.mdx', 'flow.mmd', 'flow.mermaid']) {
      expect(isEditableTextDocFile(path), path).toBe(false);
    }
  });

  test('admits markup and lockfile extensions like an IDE', () => {
    for (const path of ['index.html', 'icon.svg', 'App.vue', 'bun.lock']) {
      expect(isEditableTextDocFile(path), path).toBe(true);
    }
  });

  test('excludes bare names and dotfiles (extension-less docNames mean markdown)', () => {
    for (const path of ['Makefile', '.gitignore', 'dir/.env', 'noext']) {
      expect(isEditableTextDocFile(path), path).toBe(false);
    }
  });

  test('only the basename extension counts', () => {
    expect(isEditableTextDocFile('a.ts/readme.md')).toBe(false);
    expect(isEditableTextDocFile('a.md/util.ts')).toBe(true);
  });
});
