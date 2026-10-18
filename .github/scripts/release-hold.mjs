/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint directly, outside Turbo. */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

export const RELEASE_HOLD_SENTINEL = '.github/release-holds/converged-host';
export const REFUSED_EXIT = 2;
export const SHALLOW_BOUNDARY = 'shallow-boundary';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const shortSha = (sha) => sha.slice(0, 12);

export function gitReader(cwd = process.cwd()) {
  const run = (args, input) => {
    const res = spawnSync('git', ['--no-replace-objects', ...args], {
      cwd,
      env: gitCleanEnv(),
      encoding: 'utf8',
      input,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) throw new Error(`git ${args[0]} could not run: ${res.error.message}`);
    return res;
  };
  const failed = (args, res) =>
    new Error(
      `git ${args.join(' ')} failed (exit ${res.status ?? res.signal}): ${String(res.stderr || '').trim()}`,
    );
  const read = (args, input) => {
    const res = run(args, input);
    if (res.status !== 0) throw failed(args, res);
    return res.stdout;
  };

  return {
    resolveCommit(ref) {
      const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
      const res = run(args);
      if (res.status === 0) return res.stdout.trim();
      if (res.status !== 1) throw failed(args, res);
      throw new Error(`${ref} does not resolve to a commit in this checkout`);
    },
    objectType(sha) {
      const line = read(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${sha}\n`).trim();
      const [, type = 'missing'] = line.split(' ');
      return type === 'missing' ? null : type;
    },
    parents(sha) {
      const parents = [];
      for (const line of read(['cat-file', 'commit', sha]).split('\n')) {
        if (line === '') break;
        if (line.startsWith('parent ')) parents.push(line.slice('parent '.length));
      }
      if (!parents.every((parent) => FULL_SHA_RE.test(parent))) {
        throw new Error(`commit ${sha} records a parent that is not a full object name`);
      }
      return parents;
    },
    treeHas(sha, path) {
      return read(['ls-tree', '--full-tree', '-z', sha, '--', path]) !== '';
    },
  };
}

export function evaluateTree({ candidate, git, path = RELEASE_HOLD_SENTINEL }) {
  const sha = git.resolveCommit(candidate);
  return { kind: 'tree', candidate, sha, path, held: git.treeHas(sha, path) };
}

export function evaluatePick({ candidate, git, path = RELEASE_HOLD_SENTINEL }) {
  const sha = git.resolveCommit(candidate);
  const [firstParent = null] = git.parents(sha);
  if (firstParent !== null && git.objectType(firstParent) !== 'commit') {
    throw Object.assign(
      new Error(
        `${candidate} (${shortSha(sha)}) names first parent ${shortSha(firstParent)}, which is not in this ` +
          `clone, as at a shallow boundary, so whether it adds ${path} cannot be read. Fetch full history ` +
          '(fetch-depth: 0) and run the check again.',
      ),
      { code: SHALLOW_BOUNDARY },
    );
  }
  const carries = git.treeHas(sha, path);
  const parentCarries = firstParent === null ? false : git.treeHas(firstParent, path);
  return { kind: 'pick', candidate, sha, firstParent, path, held: carries && !parentCarries };
}

export function holdHeadline(verdict, label = verdict.candidate) {
  const what =
    verdict.kind === 'pick'
      ? `adds ${verdict.path} against its first parent`
      : `carries ${verdict.path}`;
  return (
    `${label} (${shortSha(verdict.sha)}) ${what}, the release hold the converged local host arms, so it ` +
    'is not published as a stable. See RELEASES.md, "Release hold".'
  );
}

export function describeHold(verdict, label = verdict.candidate) {
  if (verdict.held) return holdHeadline(verdict, label);
  const what =
    verdict.kind === 'pick'
      ? `does not add ${verdict.path} against its first parent ${shortSha(verdict.firstParent ?? 'none')}`
      : `does not carry ${verdict.path}`;
  return `${label} (${shortSha(verdict.sha)}) ${what}, so the release hold does not apply.`;
}

export function mainHoldReport({ ref, git, path = RELEASE_HOLD_SENTINEL }) {
  let carries;
  try {
    carries = git.treeHas(git.resolveCommit(ref), path);
  } catch (err) {
    return `::warning::Release hold: could not read whether ${ref} carries ${path} (${err.message}).`;
  }
  return carries
    ? `::notice::Release hold in force: ${ref} carries ${path}, so no beta cut from it is published as a stable until the hold's release PR removes the file.`
    : `Release hold not in force: ${ref} does not carry ${path}.`;
}

const VALUE_FLAGS = new Set(['--candidate', '--pick', '--label', '--main', '-C']);

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unrecognized argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || VALUE_FLAGS.has(value)) throw new Error(`${flag} needs a value`);
    if (flag in options) throw new Error(`${flag} was given twice`);
    options[flag] = value;
    i += 1;
  }
  if ('--candidate' in options === '--pick' in options) {
    throw new Error('give exactly one of --candidate <ref> or --pick <ref>');
  }
  return {
    kind: '--pick' in options ? 'pick' : 'tree',
    candidate: options['--candidate'] ?? options['--pick'],
    label: options['--label'] ?? null,
    main: options['--main'] ?? null,
    cwd: options['-C'] ?? null,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `::error::release-hold: ${err.message}. Usage: --candidate <ref> | --pick <ref>, with optional ` +
        '--label <name>, --main <ref> and -C <git dir>.',
    );
    process.exit(1);
  }

  const git = gitReader(options.cwd ?? process.cwd());
  const label = options.label ?? options.candidate;
  let verdict;
  try {
    const evaluate = options.kind === 'pick' ? evaluatePick : evaluateTree;
    verdict = evaluate({ candidate: options.candidate, git });
  } catch (err) {
    console.log(`::error::release-hold could not decide, so ${label} is held: ${err.message}`);
    process.exit(1);
  }

  if (options.main !== null) console.log(mainHoldReport({ ref: options.main, git }));
  const line = describeHold(verdict, label);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Release hold: ${label} ${verdict.held ? 'held' : 'not held'}\n\n${line}\n`,
    );
  }
  if (verdict.held) {
    console.log(`::error::${line}`);
    process.exit(REFUSED_EXIT);
  }
  console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
