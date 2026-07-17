#!/usr/bin/env node
/**
 * Build a stable release's changelog by accumulating the per-beta Changesets
 * bodies of the cycle into ONE section per bump level.
 *
 * The stable GitHub Release title already carries the version (e.g. `v0.32.0`),
 * and under the delta-versioning cadence the promoted beta's name no longer
 * matches the stable version, so the old preamble ("## 0.32.0", "Stable
 * promotion of beta v…", "Aggregated changes since previous stable:") was both
 * redundant and inaccurate. This drops all of it. It also drops the per-beta
 * `### vX.Y.Z-beta.N` grouping the promote workflow used to emit: instead every
 * bullet from every beta in the cycle is merged under a single
 * `### Major Changes` / `### Minor Changes` / `### Patch Changes` heading, in
 * that order, with any empty level omitted entirely.
 *
 * Input is the raw beta release bodies of the cycle concatenated on stdin (the
 * promote workflow fetches them with `gh release view`). Each raw beta body is
 * the Changesets delta for that beta — an optional lead line, then
 * `### <Level> Changes` subsections with `- ` bullets, then an internal
 * `<!-- ok-consumed-set: … -->` marker. Concatenating them yields repeated
 * `### <Level> Changes` headings; this regroups every bullet by level. Beta
 * boundaries are irrelevant to the grouping, so no separator is needed — the
 * only per-beta lines that must not leak into the changelog (the consumed-set
 * marker and the "Delta since previous beta" / "First beta of the cycle" lead)
 * are dropped by line pattern.
 *
 * Bullets keep the order they arrive in (betas are fed oldest-first, so within a
 * level the changes read in the order they were introduced), and each bullet's
 * body — including indented continuation paragraphs — is preserved verbatim.
 *
 * Usage: node scripts/aggregate-stable-changelog.mjs < concatenated-beta-bodies
 * Emits the merged changelog markdown to stdout (empty string if there are no
 * level sections at all). Pure text transform; no git, no network.
 */
import { pathToFileURL } from 'node:url';

// Order the sections render in. Also the bucket set.
const LEVELS = ['Major', 'Minor', 'Patch'];

// A Changesets bump-level heading. Beta bodies emit these at h3 (`### Minor
// Changes`); tolerate h2–h4 so a heading-level tweak upstream can't silently
// drop a whole section.
const LEVEL_HEADING = /^#{2,4} (Major|Minor|Patch) Changes\s*$/;

// Per-beta bookkeeping lines that are not user-facing changelog content:
//   - the consumed-set marker compute-next-beta.mjs embeds for delta filtering
//   - the "Delta since previous beta (…)" / "First beta of the cycle" lead line
const STRIP_LINE =
  /^(?:<!-- ok-consumed-set:.*-->|Delta since previous beta\b.*|First beta of the cycle\b.*)\s*$/;

/**
 * @param {string} input Concatenated raw beta release bodies.
 * @returns {string} Merged changelog: `### <Level> Changes` sections (Major →
 *   Minor → Patch), empty levels omitted. Trailing newline when non-empty;
 *   empty string when no level sections were found.
 */
export function aggregateStableChangelog(input) {
  const buckets = { Major: [], Minor: [], Patch: [] };
  let level = null;
  let block = null;

  const flush = () => {
    if (level && block) {
      // Drop trailing blank lines so bullets join with exactly one blank line.
      while (block.length && block[block.length - 1].trim() === '') block.pop();
      if (block.length) buckets[level].push(block.join('\n'));
    }
    block = null;
  };

  for (const line of input.split('\n')) {
    if (STRIP_LINE.test(line)) continue;
    const heading = LEVEL_HEADING.exec(line);
    if (heading) {
      flush();
      level = heading[1];
      continue;
    }
    if (line.startsWith('- ')) {
      // A new top-level bullet starts a new block; its indented continuation
      // lines and interleaved blank lines accrue until the next bullet/heading.
      flush();
      block = [line];
      continue;
    }
    if (block) block.push(line);
    // Lines before the first bullet of a section (blank lines, stray prose)
    // are dropped — only bullet blocks under a level heading survive.
  }
  flush();

  const out = [];
  for (const lvl of LEVELS) {
    if (buckets[lvl].length === 0) continue;
    out.push(`### ${lvl} Changes`, '', buckets[lvl].join('\n\n'), '');
  }
  const body = out.join('\n').replace(/\n+$/, '');
  return body ? `${body}\n` : '';
}

function main() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(aggregateStableChangelog(Buffer.concat(chunks).toString('utf8')));
  });
}

// Run main() only as a CLI, not when imported by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
