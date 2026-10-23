import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { CompilerOptions, Diagnostic, ParseConfigHost } from 'typescript';

type TypeScript = typeof import('typescript');

const IN_NODE_MODULES = /(^|[\\/])node_modules([\\/]|$)/;
const UNKNOWN_COMPILER_OPTION_DIAGNOSTICS: readonly number[] = [5023, 5025];
const NO_INPUTS_FOUND_DIAGNOSTIC = 18003;

let typescript: TypeScript | null = null;

function loadTypeScript(): TypeScript {
  typescript ??= createRequire(import.meta.url)('typescript') as TypeScript;
  return typescript;
}

function treePath(okRoot: string, path: string): string | null {
  const within = relative(okRoot, path);
  if (within === '' || within.startsWith('..') || isAbsolute(within)) return null;
  return within.split(sep).join('/');
}

function fixedOptions(ts: TypeScript): CompilerOptions {
  return {
    allowArbitraryExtensions: true,
    allowImportingTsExtensions: true,
    allowJs: true,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    preserveSymlinks: true,
    resolveJsonModule: true,
    types: [],
  };
}

function governingConfig(ts: TypeScript, okRoot: string, rootFile: string): string | undefined {
  return ts.findConfigFile(
    dirname(rootFile),
    (file) => treePath(okRoot, file) !== null && ts.sys.fileExists(file),
  );
}

function unreadableConfig(
  ts: TypeScript,
  okRoot: string,
  config: string,
  diagnostics: readonly Diagnostic[],
): Error {
  const messages = diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  );
  return new Error(
    `TypeScript could not read the path mapping of ${treePath(okRoot, config)}: ${messages.join('; ')}`,
  );
}

function pathMapping(ts: TypeScript, okRoot: string, config: string): CompilerOptions {
  const read = ts.readConfigFile(config, ts.sys.readFile);
  if (read.error !== undefined) throw unreadableConfig(ts, okRoot, config, [read.error]);
  const host: ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: () => [],
  };
  const { options, errors } = ts.parseJsonConfigFileContent(
    read.config,
    host,
    dirname(config),
    undefined,
    config,
  );
  const fatal = errors.filter(
    (diagnostic) =>
      diagnostic.code !== NO_INPUTS_FOUND_DIAGNOSTIC &&
      !UNKNOWN_COMPILER_OPTION_DIAGNOSTICS.includes(diagnostic.code),
  );
  if (fatal.length > 0) throw unreadableConfig(ts, okRoot, config, fatal);
  return { paths: options.paths, pathsBasePath: options.pathsBasePath };
}

function programFiles(
  ts: TypeScript,
  okRoot: string,
  rootNames: readonly string[],
  options: CompilerOptions,
): string[] {
  const host = ts.createCompilerHost(options);
  const readSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...rest) =>
    IN_NODE_MODULES.test(file) ? undefined : readSourceFile(file, ...rest);
  const files: string[] = [];
  for (const source of ts.createProgram({ rootNames, options, host }).getSourceFiles()) {
    if (IN_NODE_MODULES.test(source.fileName)) continue;
    const within = treePath(okRoot, source.fileName);
    if (within !== null) files.push(within);
  }
  return files;
}

export function deriveReadClosure(okRoot: string, roots: readonly string[]): string[] {
  if (roots.length === 0) return [];
  const ts = loadTypeScript();
  const byConfig = new Map<string | undefined, string[]>();
  for (const root of roots) {
    const rootFile = join(okRoot, root);
    const config = governingConfig(ts, okRoot, rootFile);
    byConfig.set(config, [...(byConfig.get(config) ?? []), rootFile]);
  }
  const files = new Set<string>();
  for (const [config, rootNames] of byConfig) {
    const options =
      config === undefined
        ? fixedOptions(ts)
        : { ...fixedOptions(ts), ...pathMapping(ts, okRoot, config) };
    for (const file of programFiles(ts, okRoot, rootNames, options)) files.add(file);
  }
  return [...files].sort();
}

export function derivedReads(
  okRoot: string,
  roots: readonly string[],
  listed: ReadonlySet<string>,
  matches: (glob: string, path: string) => boolean,
): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const matched = [...listed].filter((path) => matches(root, path));
    if (matched.length === 0) {
      throw new Error(`the root glob ${JSON.stringify(root)} matches no file in this tree`);
    }
    files.push(...matched);
  }
  const matchedFiles = [...new Set(files)].sort();
  const imported = deriveReadClosure(okRoot, matchedFiles).filter((path) => listed.has(path));
  return [...new Set([...matchedFiles, ...imported])].sort();
}
