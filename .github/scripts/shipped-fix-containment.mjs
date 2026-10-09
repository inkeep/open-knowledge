/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint directly, outside Turbo. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

export const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const TERMINAL_PR_RE = /\(#(\d+)\)\s*$/;
const FULL_SHA_RE = /\b[0-9a-f]{40}\b/g;
const APPLIED_LINE_RE = /^Applied:(.*)$/gm;
const CHERRY_LINE_RE = /^([+-]) ([0-9a-f]{40})$/;
const ANNOTATION_LIMIT = 10;
const DEFAULT_REPO = 'inkeep/open-knowledge';

export const REFUSED_EXIT = 2;

export const COVERAGE = Object.freeze({
  PROVENANCE: 'provenance',
  PR_NUMBER: 'pr-number',
});

function stableVersion(tag) {
  const match = STABLE_TAG_RE.exec(tag);
  if (!match) throw new Error(`${tag} is not a vX.Y.Z stable tag`);
  return match.slice(1).map(Number);
}

export function compareStableTags(a, b) {
  const left = stableVersion(a);
  const right = stableVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function publishedStableReleases(releases) {
  if (!Array.isArray(releases)) throw new Error('the release listing is not an array');
  const published = new Map();
  for (const release of releases) {
    if (typeof release?.tag_name !== 'string' || typeof release?.draft !== 'boolean') {
      throw new Error(
        `the release listing holds an entry without a tag name and a draft flag: ${JSON.stringify(release).slice(0, 200)}`,
      );
    }
    if (release.draft || !STABLE_TAG_RE.test(release.tag_name)) continue;
    published.set(release.tag_name, {
      tag: release.tag_name,
      body: typeof release.body === 'string' ? release.body : '',
    });
  }
  return [...published.values()].sort((a, b) => compareStableTags(a.tag, b.tag));
}

export function parseReleaseListing(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed).flat();
  return trimmed
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function appliedOrigins(body) {
  const origins = [];
  for (const [, rest] of String(body ?? '').matchAll(APPLIED_LINE_RE)) {
    for (const [sha] of rest.matchAll(FULL_SHA_RE)) {
      if (!origins.includes(sha)) origins.push(sha);
    }
  }
  return origins;
}

export function terminalPrNumber(subject) {
  return TERMINAL_PR_RE.exec(String(subject ?? ''))?.[1] ?? null;
}

export function gitRepo(cwd = process.cwd()) {
  const run = (args, input) => {
    const res = spawnSync('git', args, {
      cwd,
      env: gitCleanEnv(),
      encoding: 'utf8',
      input,
      maxBuffer: 512 * 1024 * 1024,
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
  const lines = (text) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

  return {
    resolveCommit(ref) {
      const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
      const res = run(args);
      if (res.status === 0) return res.stdout.trim();
      if (res.status !== 1) throw failed(args, res);
      const detail = String(res.stderr || '').trim();
      throw new Error(
        `${ref} does not resolve to a commit in this checkout${detail === '' ? '' : `: ${detail}`}`,
      );
    },
    stableTags() {
      return new Set(
        lines(read(['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags/'])).filter((tag) =>
          STABLE_TAG_RE.test(tag),
        ),
      );
    },
    tagsMergedInto(sha) {
      return new Set(lines(read(['tag', '--list', '--merged', sha])));
    },
    history(sha) {
      const shas = new Set();
      const prNumbers = new Set();
      for (const line of read(['log', '--format=%H %s', sha]).split('\n')) {
        if (line === '') continue;
        const space = line.indexOf(' ');
        shas.add(space === -1 ? line : line.slice(0, space));
        const pr = space === -1 ? null : terminalPrNumber(line.slice(space + 1));
        if (pr !== null) prNumbers.add(pr);
      }
      return { shas, prNumbers };
    },
    cherry(upstream, head) {
      return lines(read(['cherry', upstream, head])).map((line) => {
        const match = CHERRY_LINE_RE.exec(line);
        if (!match)
          throw new Error(`git cherry ${upstream} ${head} printed an unreadable line: ${line}`);
        return { mark: match[1], sha: match[2] };
      });
    },
    commits(shas) {
      const wanted = [...new Set(shas)];
      const found = new Map();
      if (wanted.length === 0) return found;
      const present = lines(
        read(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${wanted.join('\n')}\n`),
      )
        .map((line) => line.split(' '))
        .filter(([, type]) => type === 'commit')
        .map(([sha]) => sha);
      if (present.length === 0) return found;
      const output = read([
        'log',
        '--no-walk=unsorted',
        '-z',
        '--date=raw',
        '--format=%H%n%an%n%ae%n%ad%n%B',
        ...present,
      ]);
      for (const record of output.split('\0')) {
        const fields = record.replace(/^\n+/, '').split('\n');
        if (fields.length < 5 || !/^[0-9a-f]{40}$/.test(fields[0])) continue;
        const [sha, name, email, date, ...message] = fields;
        const text = message.join('\n').trimEnd();
        found.set(sha, {
          subject: message[0] ?? '',
          identity: [name, email, date, text].join('\n'),
        });
      }
      return found;
    },
  };
}

export function evaluateShippedFixContainment({ candidate, published, git }) {
  const candidateSha = git.resolveCommit(candidate);
  const localTags = git.stableTags();
  const untagged = published.filter((release) => !localTags.has(release.tag)).map((r) => r.tag);
  if (untagged.length > 0) {
    throw new Error(
      `published stable Release(s) with no tag in this checkout: ${untagged.join(', ')}. ` +
        'Fetch every tag with full history (fetch-depth: 0) and run the check again.',
    );
  }

  const contained = git.tagsMergedInto(candidateSha);
  const unmerged = published.filter((release) => !contained.has(release.tag));
  const entries = new Map();
  let records = 0;
  let plusRecords = 0;
  for (const release of unmerged) {
    for (const { mark, sha } of git.cherry(candidateSha, `refs/tags/${release.tag}`)) {
      records += 1;
      let entry = entries.get(sha);
      if (!entry) {
        entry = { sha, patchEquivalent: false, stables: [] };
        entries.set(sha, entry);
      }
      if (mark === '-') {
        entry.patchEquivalent = true;
      } else {
        plusRecords += 1;
        entry.stables.push(release);
      }
    }
  }

  const plusCommits = [...entries.values()].filter((entry) => entry.stables.length > 0).length;
  const pending = [...entries.values()].filter((entry) => !entry.patchEquivalent);
  const commits = [];
  if (pending.length > 0) {
    const history = git.history(candidateSha);
    const originsOf = (entry) => [
      ...new Set(entry.stables.flatMap((release) => appliedOrigins(release.body))),
    ];
    const info = git.commits([...pending.map((e) => e.sha), ...pending.flatMap(originsOf)]);
    for (const entry of pending) {
      const self = info.get(entry.sha);
      if (!self) throw new Error(`could not read commit ${entry.sha}, which git cherry listed`);
      const pr = terminalPrNumber(self.subject);
      const origin = originsOf(entry).find(
        (sha) => info.get(sha)?.identity === self.identity && history.shas.has(sha),
      );
      let coverage = null;
      if (origin) coverage = COVERAGE.PROVENANCE;
      else if (pr !== null && history.prNumbers.has(pr)) coverage = COVERAGE.PR_NUMBER;
      commits.push({
        sha: entry.sha,
        subject: self.subject,
        pr,
        origin: origin ?? null,
        coverage,
        stables: entry.stables.map((release) => release.tag).sort(compareStableTags),
      });
    }
  }

  const uncovered = commits
    .filter((commit) => commit.coverage === null)
    .sort((a, b) => compareStableTags(a.stables[0], b.stables[0]) || a.sha.localeCompare(b.sha));
  const count = (coverage) => commits.filter((commit) => commit.coverage === coverage).length;
  return {
    ok: uncovered.length === 0,
    candidate,
    candidateSha,
    published: published.length,
    checked: unmerged.map((release) => release.tag),
    records,
    plusRecords,
    plusCommits,
    coveredByProvenance: count(COVERAGE.PROVENANCE),
    coveredByPrNumber: count(COVERAGE.PR_NUMBER),
    commits,
    uncovered,
  };
}

const shortSha = (sha) => sha.slice(0, 12);
const prLabel = (commit) => (commit.pr === null ? 'no PR number' : `PR #${commit.pr}`);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const shippedIn = (commit) =>
  commit.stables.length === 1
    ? commit.stables[0]
    : `${commit.stables[0]} and ${plural(commit.stables.length - 1, 'later stable', 'later stables')}`;

export function refusalHeadline(verdict, label = verdict.candidate) {
  const listed = verdict.uncovered
    .slice(0, ANNOTATION_LIMIT)
    .map(
      (commit) =>
        `${commit.pr === null ? shortSha(commit.sha) : `#${commit.pr}`} (${shippedIn(commit)})`,
    )
    .join(', ');
  const more =
    verdict.uncovered.length > ANNOTATION_LIMIT
      ? ` and ${verdict.uncovered.length - ANNOTATION_LIMIT} more`
      : '';
  return `${label} lacks ${plural(verdict.uncovered.length, 'fix', 'fixes')} that a published stable already shipped: ${listed}${more}.`;
}

export function describeVerdict(verdict, label = verdict.candidate) {
  const where = `${label} (${shortSha(verdict.candidateSha)})`;
  const tally =
    `Checked ${plural(verdict.published, 'published stable Release', 'published stable Releases')}, ` +
    `${verdict.checked.length} of them not ancestors of it: ${plural(verdict.records, 'commit record', 'commit records')}, ` +
    `${plural(verdict.plusCommits, 'commit', 'commits')} that git cherry marks +, ` +
    `${verdict.coveredByProvenance} matched to the origin a Release recorded as Applied, ` +
    `${verdict.coveredByPrNumber} matched by terminal PR number.`;
  if (verdict.ok) {
    return [`${where} contains every fix the published stables shipped. ${tally}`];
  }
  return [
    `${where} lacks ${plural(verdict.uncovered.length, 'fix', 'fixes')} that published stables already shipped. ${tally}`,
    ...verdict.uncovered.map(
      (commit) =>
        `  ${shortSha(commit.sha)} ${commit.subject} [${prLabel(commit)}; shipped in ${commit.stables.join(', ')}]`,
    ),
    'A stable must contain every commit a published stable shipped: the same patch, the origin the ' +
      "point release's notes record as Applied, or a commit with the same terminal PR number. Release " +
      'from a commit that contains these, or ship them together with it.',
  ];
}

export function summaryMarkdown(verdict, label = verdict.candidate) {
  if (verdict.ok) {
    return `### Shipped-fix containment: ${label} contains every published fix\n\n${describeVerdict(verdict, label)[0]}\n`;
  }
  const escapePipes = (text) => text.replaceAll('|', '\\|');
  return [
    `### Shipped-fix containment: ${label} refused`,
    '',
    refusalHeadline(verdict, label),
    '',
    '| Commit | Subject | PR | Shipped in |',
    '| --- | --- | --- | --- |',
    ...verdict.uncovered.map(
      (commit) =>
        `| \`${shortSha(commit.sha)}\` | ${escapePipes(commit.subject)} | ${commit.pr === null ? 'none' : `#${commit.pr}`} | ${commit.stables.join(', ')} |`,
    ),
    '',
  ].join('\n');
}

export function unpublishedBaseReason({ latestStableTag, publishedTags }) {
  if (publishedTags.includes(latestStableTag)) return null;
  const newestPublished = [...publishedTags].sort(compareStableTags).at(-1);
  return (
    `The newest stable tag ${latestStableTag} has no published Release (the newest published stable is ` +
    `${newestPublished ?? 'none'}). A point release adds fixes to the stable users already have, and its ` +
    `version follows the newest tag, so it cannot be built over ${latestStableTag}. Publish ${latestStableTag} ` +
    'if its release build can still pass, or let a newer stable supersede it, then run again. A tag the ' +
    'shipped-fix check refused never passes it.'
  );
}

export function fetchReleaseListing(repo) {
  const res = spawnSync(
    'gh',
    [
      'api',
      '-X',
      'GET',
      `repos/${repo}/releases?per_page=100`,
      '--paginate',
      '--jq',
      '.[] | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) | {tag_name, draft, body}',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300_000 },
  );
  if (res.error || res.status !== 0) {
    throw new Error(
      `listing the releases of ${repo} failed: ${res.error?.message ?? String(res.stderr || res.stdout || '').trim()}`,
    );
  }
  return parseReleaseListing(res.stdout);
}

export function createShippedFixCheck({
  cwd = process.cwd(),
  repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
  listReleases = () => fetchReleaseListing(repo),
  git = gitRepo(cwd),
} = {}) {
  let published;
  const load = () => {
    if (published === undefined) {
      const listing = listReleases();
      const stableEntries = listing.filter((release) =>
        STABLE_TAG_RE.test(release?.tag_name ?? ''),
      );
      if (stableEntries.length === 0 && git.stableTags().size > 0) {
        throw new Error(
          `the release listing for ${repo} holds no stable Release although this checkout has stable tags; ` +
            'refusing to read that as nothing shipped.',
        );
      }
      published = publishedStableReleases(listing);
    }
    return published;
  };
  return {
    publishedStableTags: () => load().map((release) => release.tag),
    resolveCommit: (ref) => git.resolveCommit(ref),
    evaluate: (candidate) => evaluateShippedFixContainment({ candidate, published: load(), git }),
  };
}

export function publishedRepairExemption({ candidate, tag, check }) {
  if (!STABLE_TAG_RE.test(tag)) {
    throw new Error(
      `--allow-published-repair takes a vX.Y.Z stable tag, not ${JSON.stringify(tag)}`,
    );
  }
  const tagSha = check.resolveCommit(`refs/tags/${tag}`);
  const candidateSha = check.resolveCommit(candidate);
  if (tagSha !== candidateSha) {
    throw new Error(
      `--allow-published-repair names ${tag} (${shortSha(tagSha)}), but the candidate ${candidate} is ` +
        `${shortSha(candidateSha)}; the exemption covers only the tag being checked`,
    );
  }
  return check.publishedStableTags().includes(tag);
}

function splitList(raw) {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const VALUE_FLAGS = new Set([
  '--candidate',
  '--label',
  '--allow-published-repair',
  '--matrix',
  '--expect-refuse',
  '--expect-admit',
  '--releases',
  '--repo',
  '-C',
]);

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
  if ('--candidate' in options === '--matrix' in options) {
    throw new Error('give exactly one of --candidate <ref> or --matrix <refs>');
  }
  if ('--allow-published-repair' in options && !('--candidate' in options)) {
    throw new Error('--allow-published-repair goes with --candidate, not --matrix');
  }
  return {
    candidate: options['--candidate'] ?? null,
    label: options['--label'] ?? null,
    allowPublishedRepair: options['--allow-published-repair'] ?? null,
    matrix: '--matrix' in options ? splitList(options['--matrix']) : null,
    expectRefuse: splitList(options['--expect-refuse']),
    expectAdmit: splitList(options['--expect-admit']),
    releases: options['--releases'] ?? null,
    repo: options['--repo'] ?? null,
    cwd: options['-C'] ?? null,
  };
}

export function runMatrix({ candidates, expectRefuse = [], expectAdmit = [], check }) {
  const rows = candidates.map((candidate) => ({ candidate, verdict: check.evaluate(candidate) }));
  const mismatches = rows.flatMap(({ candidate, verdict }) => {
    if (expectRefuse.includes(candidate) && verdict.ok)
      return [`${candidate}: admitted, expected a refusal`];
    if (expectAdmit.includes(candidate) && !verdict.ok)
      return [`${candidate}: refused, expected admission`];
    return [];
  });
  const unknown = [...expectRefuse, ...expectAdmit].filter((ref) => !candidates.includes(ref));
  for (const ref of unknown)
    mismatches.push(`${ref}: expected a verdict but it is not in --matrix`);
  const totals = rows.reduce(
    (sum, { verdict }) => ({
      pairs: sum.pairs + verdict.checked.length,
      records: sum.records + verdict.records,
      plusRecords: sum.plusRecords + verdict.plusRecords,
    }),
    { pairs: 0, records: 0, plusRecords: 0 },
  );
  return { rows, mismatches, totals };
}

function matrixReport({ rows, mismatches, totals }) {
  const published = rows[0]?.verdict.published ?? 0;
  const out = [
    '| Candidate | Commit | Non-ancestor stables | Cherry records | Raw + records | + commits | By provenance | By PR number | Uncovered | Verdict |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(
      ({ candidate, verdict }) =>
        `| ${candidate} | ${shortSha(verdict.candidateSha)} | ${verdict.checked.length} | ${verdict.records} | ` +
        `${verdict.plusRecords} | ${verdict.plusCommits} | ${verdict.coveredByProvenance} | ` +
        `${verdict.coveredByPrNumber} | ${verdict.uncovered.length} | ${verdict.ok ? 'ADMIT' : 'REFUSE'} |`,
    ),
    '',
    `Published stable Releases: ${published}. Candidates: ${rows.length}. git cherry pairs: ${totals.pairs}. ` +
      `Commit records: ${totals.records}, of which ${totals.plusRecords} raw + records.`,
  ];
  for (const { candidate, verdict } of rows) {
    if (verdict.ok) continue;
    out.push('', `${candidate} uncovered:`);
    for (const commit of verdict.uncovered) {
      out.push(
        `  ${shortSha(commit.sha)} ${commit.subject} [${prLabel(commit)}; shipped in ${commit.stables.join(', ')}]`,
      );
    }
  }
  out.push(
    '',
    mismatches.length === 0
      ? 'Expected verdicts: all matched.'
      : `Expected verdicts: ${mismatches.length} mismatch(es):\n${mismatches.map((m) => `  ${m}`).join('\n')}`,
  );
  return out.join('\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `::error::shipped-fix-containment: ${err.message}. Usage: --candidate <ref> [--label <name>] ` +
        '[--allow-published-repair <tag>] | --matrix <refs> [--expect-refuse <refs>] [--expect-admit <refs>]; ' +
        'with optional --releases <file>, --repo <owner/name>, -C <git dir>.',
    );
    process.exit(1);
  }

  let check;
  let verdict;
  let matrix;
  let repairOnly = false;
  try {
    check = createShippedFixCheck({
      cwd: options.cwd ?? process.cwd(),
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.releases
        ? { listReleases: () => parseReleaseListing(readFileSync(options.releases, 'utf8')) }
        : {}),
    });
    if (options.matrix) {
      matrix = runMatrix({
        candidates: options.matrix,
        expectRefuse: options.expectRefuse,
        expectAdmit: options.expectAdmit,
        check,
      });
    } else {
      repairOnly =
        options.allowPublishedRepair !== null &&
        publishedRepairExemption({
          candidate: options.candidate,
          tag: options.allowPublishedRepair,
          check,
        });
      if (!repairOnly) verdict = check.evaluate(options.candidate);
    }
  } catch (err) {
    console.error(`::error::shipped-fix-containment could not decide: ${err.message}`);
    process.exit(1);
  }

  if (matrix) {
    console.log(matrixReport(matrix));
    process.exit(matrix.mismatches.length === 0 ? 0 : 1);
  }

  if (repairOnly) {
    const tag = options.allowPublishedRepair;
    console.log(
      `::notice::${tag} already has a published Release; this repair may update assets and release metadata ` +
        'and dispatch desktop-release-published to release consumers for reconciliation, without explicitly requesting Latest or dispatching npm ' +
        'publication. The shipped-fix check is skipped for this published-tag repair.',
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Shipped-fix containment: ${tag} not checked\n\n${tag} is already published; this repair may update assets and release metadata and dispatch desktop-release-published to release consumers for reconciliation, without explicitly requesting Latest or dispatching npm publication.\n`,
      );
    }
    return;
  }

  const label = options.label ?? options.candidate;
  for (const line of describeVerdict(verdict, label)) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(verdict, label));
  }
  if (!verdict.ok) {
    console.log(`::error::${refusalHeadline(verdict, label)}`);
    process.exit(REFUSED_EXIT);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
