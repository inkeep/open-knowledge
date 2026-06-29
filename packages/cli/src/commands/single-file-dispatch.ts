const VALUE_TAKING_GLOBAL_FLAGS = new Set(['--cwd', '--log-level']);

export interface ScannedRootArgv {
  readonly operands: string[];
  readonly cwd: string | null;
  readonly sawTerminalFlag: boolean;
}

export function scanRootArgv(argv: string[]): ScannedRootArgv {
  const operands: string[] = [];
  let cwd: string | null = null;
  let sawTerminalFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h' || tok === '--version' || tok === '-V') {
      sawTerminalFlag = true;
      break;
    }
    if (tok === '--cwd' || tok === '--log-level') {
      if (tok === '--cwd') cwd = argv[i + 1] ?? null;
      i++; // consume the value token
      continue;
    }
    if (tok.startsWith('--cwd=')) {
      cwd = tok.slice('--cwd='.length);
      continue;
    }
    if (tok.startsWith('--log-level=')) continue;
    if (tok === '--no-color' || tok === '--color') continue;
    if (tok.startsWith('-')) {
      if (VALUE_TAKING_GLOBAL_FLAGS.has(tok)) i++;
      continue;
    }
    operands.push(tok);
  }

  return { operands, cwd, sawTerminalFlag };
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

/** Markdown-extension test mirroring `SUPPORTED_DOC_EXTENSIONS` — the cheap half
 *  of the fileish predicate (the other half is an existing-file `existsSync`). */
export function hasMarkdownExtension(token: string): boolean {
  return /\.(md|mdx)$/i.test(token);
}
