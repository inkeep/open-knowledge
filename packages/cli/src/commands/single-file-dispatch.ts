/**
 * Bare `ok <file>` argv pre-dispatch.
 *
 * Commander treats the first operand as a subcommand name once subcommands are
 * registered; an unrecognized token's behavior (route-to-program-action vs
 * "unknown command" vs "too many arguments") is version- and option-sensitive.
 * Rather than depend on that, `cli.ts` inspects argv BEFORE `program.parseAsync`
 * (and before desktop detection) and, when the first operand is a markdown file
 * — or `ok open <file>` names one — routes to the single-file open flow.
 *
 * The decision is split into a pure argv scan (`scanRootArgv`) + a pure target
 * decision (`decideSingleFileTarget`) so `cli.test.ts` can pin the dispatch
 * matrix without a filesystem.
 */

import { statSync } from 'node:fs';

/** Global root options that consume the following token as their value. */
const VALUE_TAKING_GLOBAL_FLAGS = new Set(['--cwd', '--log-level']);

export interface ScannedRootArgv {
  /** Positional operands, in order, with global options stripped. */
  readonly operands: string[];
  /** `--cwd <dir>` (or `--cwd=<dir>`) when present — used to resolve relative file paths. */
  readonly cwd: string | null;
  /** True when a terminal/help flag (`-h`/`--help`/`-V`/`--version`) appeared before any operand. */
  readonly sawTerminalFlag: boolean;
}

/**
 * Scan the root argv (everything after `node cli.mjs`) into positional operands
 * + the `--cwd` value, stripping the known global options. Stops collecting at
 * a help/version flag so `ok --help` / `ok -V` fall straight through to
 * Commander. Pure — no filesystem access.
 */
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
      // An unrecognized option before any operand — let Commander parse + report.
      // (Known value-taking flags are handled above.)
      if (VALUE_TAKING_GLOBAL_FLAGS.has(tok)) i++;
      continue;
    }
    operands.push(tok);
  }

  return { operands, cwd, sawTerminalFlag };
}

export interface DecideSingleFileOptions {
  /** Names of every registered subcommand (`program.commands.map(c => c.name())`). */
  readonly knownSubcommands: ReadonlySet<string>;
  /** True iff the token should be treated as a markdown file (`.md`/`.mdx`, or an existing file). */
  readonly isFileish: (token: string) => boolean;
}

/**
 * Decide whether argv names a single-file open target. Returns the file token
 * (the operand to open) or `null` for passthrough (let Commander handle it).
 *
 *   - `ok open <file>` where `<file>` is fileish → the file (escape-hatch for
 *     the extensionless-collision edge; leaves `ok open <doc>`'s ext-less
 *     project-doc contract untouched because only fileish 2nd operands route
 *     here).
 *   - `ok <file>` where the first operand is fileish AND not a subcommand → the file.
 *   - everything else (known subcommand, no operand, non-fileish token) → null.
 */
export function decideSingleFileTarget(
  operands: string[],
  opts: DecideSingleFileOptions,
): string | null {
  if (operands.length === 0) return null;
  const first = operands[0];

  // `ok open <file>` escape hatch — intercept only when the 2nd operand is a
  // real file, so the existing `ok open <ext-less-doc>` contract is untouched.
  if (first === 'open' && operands[1] !== undefined && opts.isFileish(operands[1])) {
    return operands[1];
  }

  // A token that matches a subcommand name is always that subcommand.
  if (opts.knownSubcommands.has(first)) return null;

  if (opts.isFileish(first)) return first;
  return null;
}

/** Markdown-extension test mirroring `SUPPORTED_DOC_EXTENSIONS` — the cheap half
 *  of the fileish predicate (the other half is an existing-regular-file stat). */
export function hasMarkdownExtension(token: string): boolean {
  return /\.(md|mdx)$/i.test(token);
}

/**
 * The fs-backed `isFileish` predicate the root dispatch is parameterized over
 * (the only filesystem-touching part of this module; `scanRootArgv` +
 * `decideSingleFileTarget` stay pure). A token routes to the single-file open
 * flow when it has a markdown extension OR names an existing regular FILE.
 *
 * Directories are explicitly excluded: single-file open only handles `.md`/`.mdx`
 * files (it throws "edits markdown files" otherwise), so an existing folder must
 * fall through to `ok open`'s in-project folder routing. `existsSync` alone is
 * true for directories, which wrongly captured `ok open <folder>` — this stats
 * for a regular file instead.
 */
export function isFileishTarget(absPath: string, token: string): boolean {
  if (hasMarkdownExtension(token)) return true;
  try {
    return statSync(absPath).isFile();
  } catch (err) {
    // ENOENT/ENOTDIR = the token isn't an existing file (the common, expected
    // case) → not fileish, route to Commander silently. Any other code means a
    // real file we couldn't stat — log it so a misroute is diagnosable.
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      process.stderr.write(
        `[ok] statSync failed for ${absPath} (${code ?? 'unknown'}); treating as non-fileish\n`,
      );
    }
    return false;
  }
}
