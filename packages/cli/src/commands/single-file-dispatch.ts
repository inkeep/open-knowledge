import { statSync } from 'node:fs';

const VALUE_TAKING_FLAGS = new Set(['--cwd', '--log-level', '--project', '--scope']);

export interface ScannedRootArgv {
  readonly operands: string[];
  readonly cwd: string | null;
  readonly project: string | null;
  readonly sawTerminalFlag: boolean;
}

export function scanRootArgv(argv: string[]): ScannedRootArgv {
  const operands: string[] = [];
  let cwd: string | null = null;
  let project: string | null = null;
  let sawTerminalFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h' || tok === '--version' || tok === '-V') {
      sawTerminalFlag = true;
      break;
    }
    if (VALUE_TAKING_FLAGS.has(tok)) {
      const value = argv[i + 1] ?? null;
      if (tok === '--cwd') cwd = value;
      if (tok === '--project') project = value;
      i++;
      continue;
    }
    if (tok.startsWith('--cwd=')) {
      cwd = tok.slice('--cwd='.length);
      continue;
    }
    if (tok.startsWith('--project=')) {
      project = tok.slice('--project='.length);
      continue;
    }
    if (tok.startsWith('-')) {
      continue;
    }
    operands.push(tok);
  }

  return { operands, cwd, project, sawTerminalFlag };
}

export interface DecideSingleFileOptions {
  readonly knownSubcommands: ReadonlySet<string>;
  readonly isFileish: (token: string) => boolean;
}

export function decideSingleFileTarget(
  operands: string[],
  opts: DecideSingleFileOptions,
): string | null {
  if (operands.length === 0) return null;
  const first = operands[0];

  if (first === 'open' && operands[1] !== undefined && opts.isFileish(operands[1])) {
    return operands[1];
  }

  if (opts.knownSubcommands.has(first)) return null;

  if (opts.isFileish(first)) return first;
  return null;
}

export function hasMarkdownExtension(token: string): boolean {
  return /\.(md|mdx)$/i.test(token);
}

export function isFileishTarget(absPath: string, token: string): boolean {
  if (hasMarkdownExtension(token)) return true;
  try {
    return statSync(absPath).isFile();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      process.stderr.write(
        `[ok] statSync failed for ${absPath} (${code ?? 'unknown'}); treating as non-fileish\n`,
      );
    }
    return false;
  }
}

export interface RootDispatch {
  readonly absPath: string;
  readonly projectRoot: string | null;
}

export interface ResolveRootDispatchOptions {
  readonly knownSubcommands: ReadonlySet<string>;
  readonly cwd: string;
  readonly isFileish: (absPath: string, token: string) => boolean;
  readonly resolvePath: (base: string, token: string) => string;
}

export function resolveRootDispatch(
  argv: string[],
  opts: ResolveRootDispatchOptions,
): RootDispatch | null {
  const scanned = scanRootArgv(argv);
  if (scanned.sawTerminalFlag) return null;
  const baseDir = scanned.cwd ? opts.resolvePath(opts.cwd, scanned.cwd) : opts.cwd;
  const target = decideSingleFileTarget(scanned.operands, {
    knownSubcommands: opts.knownSubcommands,
    isFileish: (t) => opts.isFileish(opts.resolvePath(baseDir, t), t),
  });
  if (target === null) return null;
  return {
    absPath: opts.resolvePath(baseDir, target),
    projectRoot: scanned.project === null ? null : opts.resolvePath(baseDir, scanned.project),
  };
}
