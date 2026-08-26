/**
 * NUL-safe surface for every git command that lists or parses PATHS.
 *
 * Git C-quotes non-ASCII / unusual filenames in its default newline output
 * (`core.quotepath`), e.g. `hyvää yötä.md` prints as
 * `"hyv\303\244\303\244 y\303\266t\303\244.md"`. Reusing that escaped string as
 * a pathspec matches nothing, which silently broke sync of non-ASCII-named
 * files (deletions never committed, conflicts misrouted). Passing `-z` switches
 * git to raw NUL-separated bytes; these wrappers own the `-z` flag AND the
 * matching parser, so a new path-listing call site cannot reintroduce the
 * quoting bug. Prefer `listNames` / `listPorcelainPaths` / `listNameStatus`
 * over a bare `git.raw([...])` whenever the output is parsed as paths.
 *
 * Four record grammars are covered — each git command family emits its own, so
 * a single "split on NUL" helper is not enough:
 *   - `--name-only -z`        flat `path\0path\0…`                     -> splitNulSeparatedPaths
 *   - `status --porcelain -z` `XY path\0`, R/C add an origin record    -> parsePorcelainPaths
 *                             (XY-preserving variant)                  -> parsePorcelainEntries
 *   - `--name-status -z`      `status\0path\0` or R/C `status\0from\0to\0` -> parseNameStatusZ
 *   - `ls-tree --long -z`     `mode type object size\tpath\0`          -> parseTreeLongEntriesZ
 *
 * No runtime dependency on `simple-git` (the SimpleGit import is type-only), so
 * importing this module never triggers simple-git's load — callers that defer
 * simple-git for test isolation can import these wrappers directly.
 */
import type { SimpleGit } from 'simple-git';

/**
 * Flat NUL-separated path list — the shape every `--name-only -z` command emits
 * (`diff`, `diff-tree`, `diff-index`, `ls-tree`). The trailing empty field
 * after the final NUL is dropped.
 */
export function splitNulSeparatedPaths(out: string): string[] {
  return out.split('\0').filter((path) => path.length > 0);
}

/**
 * `git status --porcelain -z`: NUL-separated `XY<space>PATH` records. A
 * rename/copy emits the ORIGIN path as a separate following record with no
 * status prefix, so skip that record — otherwise the old name reads as a
 * distinct entry. Rename detection is on by default (`status.renames` inherits
 * `diff.renames`, which defaults to true) and reports in EITHER column: a staged
 * rename as `R `, a worktree rename as ` R`. Both are skipped — keying off the
 * index column alone re-parses the origin record as a status record and invents
 * a file that does not exist.
 */
export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') i++;
  }
  return paths;
}

/**
 * One `git status --porcelain -z` record with both status columns preserved.
 * `x` is the index (staged) column, `y` the worktree (unstaged) column; either
 * may be a space meaning "unchanged in that column". `origPath` carries the
 * rename/copy source when `x` is `R` or `C`.
 */
export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

/**
 * `git status --porcelain -z`, keeping the XY columns that
 * {@link parsePorcelainPaths} discards.
 *
 * Same record grammar, so the two share the rename-origin skip: git emits the
 * ORIGIN path as a bare following record with no status prefix, which must be
 * consumed as this entry's `origPath` rather than read as a distinct path.
 * Callers that only need the path set should keep using `parsePorcelainPaths` —
 * this exists for the working-tree status surface, which has to tell a staged
 * modification from an unstaged one.
 */
export function parsePorcelainEntries(porcelain: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  const records = porcelain.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    // `XY<space>PATH` — a shorter record cannot carry a path, and the trailing
    // empty field after the final NUL lands here too.
    if (record.length < 4) continue;
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const entry: PorcelainEntry = { x, y, path: record.slice(3) };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // Git emits `XY<space>NEW\0OLD\0` for a rename: the record above holds the
      // destination, the next bare record the source.
      //
      // BOTH columns, not just the index one: `diff.renames` defaults to true,
      // so a worktree rename (`git add -N` on the destination, `git add -p` on a
      // new file) reports as ` R` — origin in the Y column. Consuming only on X
      // left the origin record to be re-parsed as a status record on the next
      // iteration, inventing a file that does not exist (` R bravo.md\0alpha.md`
      // yielded a phantom `ha.md` in both staged and notStaged).
      const origin = records[i + 1];
      if (origin !== undefined && origin.length > 0) entry.origPath = origin;
      i++;
    }
    entries.push(entry);
  }
  return entries;
}

/** One `--name-status` change. `from`/`to` are equal for non-rename statuses. */
export interface NameStatusRow {
  status: string;
  from: string;
  to: string;
}

/**
 * `git diff[-tree] --name-status -z`: a flat NUL-separated FIELD stream, not one
 * record per line. Each change is `status\0path\0`, except a rename/copy
 * (`R`/`C`) which is `status\0from\0to\0`. Parsing the non-`-z` line/tab shape
 * would both C-unescape-fail on non-ASCII paths and split a path on an embedded
 * newline; consuming the field stream keeps every byte of the path intact.
 */
export function parseNameStatusZ(out: string): NameStatusRow[] {
  const fields = out.split('\0');
  const rows: NameStatusRow[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i] ?? '';
    if (status === '') break; // trailing empty field after the final NUL
    if (status[0] === 'R' || status[0] === 'C') {
      rows.push({ status, from: fields[i + 1] ?? '', to: fields[i + 2] ?? '' });
      i += 3;
    } else {
      const path = fields[i + 1] ?? '';
      rows.push({ status, from: path, to: path });
      i += 2;
    }
  }
  return rows;
}

/** One `ls-tree --long -z` entry. */
export interface TreeLongEntry {
  mode: string;
  type: string;
  object: string;
  size: number;
  path: string;
}

/**
 * `git ls-tree --long -z`: NUL-separated entries with a TAB between the
 * metadata prefix and raw path. The size field can be `-` for non-blob entries;
 * callers that need numeric sizes can treat that as 0.
 */
export function parseTreeLongEntriesZ(out: string): TreeLongEntry[] {
  const entries: TreeLongEntry[] = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx < 0) continue;
    const [mode = '', type = '', object = '', sizeRaw = '0'] = record
      .slice(0, tabIdx)
      .trim()
      .split(/\s+/);
    const size = Number(sizeRaw);
    entries.push({
      mode,
      type,
      object,
      size: Number.isFinite(size) ? size : 0,
      path: record.slice(tabIdx + 1),
    });
  }
  return entries;
}

/**
 * Insert `-z` immediately after the git subcommand so it precedes any positional
 * revision / tree-ish / pathspec. `-z` is an option git accepts anywhere among
 * the options, but appending it at the end would place it after a `--` pathspec,
 * where git reads it as a path. `args[0]` MUST be the git subcommand.
 */
function rawZ(git: SimpleGit, args: string[]): Promise<string> {
  const [subcommand = '', ...rest] = args;
  return git.raw([subcommand, '-z', ...rest]);
}

/**
 * Run a `--name-only` path-listing command (`diff`, `diff-tree`, `diff-index`,
 * `ls-tree`) with `-z` and return the raw UTF-8 paths. Pass args WITHOUT `-z`.
 */
export async function listNames(git: SimpleGit, args: string[]): Promise<string[]> {
  return splitNulSeparatedPaths(await rawZ(git, args));
}

/**
 * Run `git status --porcelain` (plus any extra flags) with `-z` and return the
 * paths, rename origin records skipped.
 */
export async function listPorcelainPaths(
  git: SimpleGit,
  args: string[] = ['status', '--porcelain'],
): Promise<string[]> {
  return parsePorcelainPaths(await rawZ(git, args));
}

/**
 * Run `git status --porcelain` with `-z` and return entries with both status
 * columns intact. The XY-preserving counterpart to {@link listPorcelainPaths}.
 */
export async function listPorcelainEntries(
  git: SimpleGit,
  args: string[] = ['status', '--porcelain'],
): Promise<PorcelainEntry[]> {
  return parsePorcelainEntries(await rawZ(git, args));
}

/**
 * Run a `--name-status` command (`diff`, `diff-tree`) with `-z` and return the
 * parsed rows with real-UTF-8 `from`/`to` paths.
 */
export async function listNameStatus(git: SimpleGit, args: string[]): Promise<NameStatusRow[]> {
  return parseNameStatusZ(await rawZ(git, args));
}

/**
 * Run `git ls-tree --long` with `-z` and return parsed entries with real UTF-8
 * paths and numeric blob sizes. Pass args WITHOUT `-z`.
 */
export async function listTreeLongEntries(
  git: SimpleGit,
  args: string[],
): Promise<TreeLongEntry[]> {
  return parseTreeLongEntriesZ(await rawZ(git, args));
}
