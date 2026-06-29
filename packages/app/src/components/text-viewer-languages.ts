import type { Language } from '@codemirror/language';

const cache = new Map<string, Promise<Language | null>>();

function loadCodeMirrorLanguage(canonical: string): Promise<Language | null> {
  const cached = cache.get(canonical);
  if (cached) return cached;
  const promise = resolveLanguage(canonical);
  cache.set(canonical, promise);
  return promise;
}

async function resolveLanguage(canonical: string): Promise<Language | null> {
  switch (canonical) {
    case 'bash':
    case 'shell':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/shell')).shell,
      );
    case 'c':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).c,
      );
    case 'cpp':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).cpp,
      );
    case 'csharp':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).csharp,
      );
    case 'css':
    case 'less':
    case 'scss':
      return (await import('@codemirror/lang-css')).css().language;
    case 'diff':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/diff')).diff,
      );
    case 'go':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/go')).go,
      );
    case 'ini':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/properties')).properties,
      );
    case 'java':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).java,
      );
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript().language;
    case 'json':
      return (await import('@codemirror/lang-json')).json().language;
    case 'kotlin':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).kotlin,
      );
    case 'lua':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/lua')).lua,
      );
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown().language;
    case 'objectivec':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/clike')).objectiveC,
      );
    case 'perl':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/perl')).perl,
      );
    case 'python':
      return (await import('@codemirror/lang-python')).python().language;
    case 'r':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/r')).r,
      );
    case 'ruby':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/ruby')).ruby,
      );
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust().language;
    case 'sql':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/sql')).standardSQL,
      );
    case 'swift':
      return (await import('@codemirror/language')).StreamLanguage.define(
        (await import('@codemirror/legacy-modes/mode/swift')).swift,
      );
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({
        typescript: true,
        jsx: true,
      }).language;
    case 'xml':
      return (await import('@codemirror/lang-html')).html().language;
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml().language;
    default:
      return null;
  }
}

export async function loadCodeMirrorLanguageForExtension(
  extension: string,
  canonical: string | null,
): Promise<Language | null> {
  if (extension === 'canvas') return (await import('@codemirror/lang-json')).json().language;
  if (canonical) {
    const lang = await loadCodeMirrorLanguage(canonical);
    if (lang) return lang;
  }
  if (extension === 'toml') {
    return (await import('@codemirror/language')).StreamLanguage.define(
      (await import('@codemirror/legacy-modes/mode/toml')).toml,
    );
  }
  return null;
}
