#!/usr/bin/env node
/**
 * Render a marker-delimited "Downloads" table into a GitHub Release body,
 * built from the assets that are ACTUALLY attached to the Release — a row
 * never appears for an installer that failed to upload.
 *
 * Why marker-delimited: the release body is not ours alone. The beta cadence
 * embeds a hidden `<!-- ok-consumed-set: … -->` marker that
 * compute-next-beta.mjs reads back from the previous beta's body, and the
 * Slack/Discord announcements + aggregate-stable-changelog.mjs all consume
 * the body downstream. Replacing ONLY the span between
 * `<!-- ok-downloads:start -->` and `<!-- ok-downloads:end -->` keeps every
 * other byte of the body intact and makes re-renders idempotent; the
 * downstream consumers strip the block on their side.
 *
 * Usage:
 *   gh release view "$TAG" --json body,assets \
 *     | node scripts/render-release-downloads.mjs --tag v0.43.0 --repo inkeep/open-knowledge
 *
 * Reads `{body, assets: [{name}]}` JSON on stdin, emits the updated body on
 * stdout. Download URLs are tag-specific (`releases/download/<tag>/…`), so
 * the table stays correct after a newer release claims `latest`.
 */
import { pathToFileURL } from 'node:url';

export const DOWNLOADS_START = '<!-- ok-downloads:start -->';
export const DOWNLOADS_END = '<!-- ok-downloads:end -->';

/**
 * The known user-facing installers, in display order. Update manifests,
 * blockmaps, and the mac updater zip are deliberately absent — they are
 * updater plumbing, not human downloads (the versioned mac zip exists only
 * because Squirrel.Mac requires a zip for the in-place swap).
 *
 * `match` is a predicate on the asset name rather than a literal so the one
 * versioned name shape (none today) or a future arch addition stays a
 * one-line change.
 */
const ROWS = [
  { platform: 'macOS', arch: 'Apple Silicon', match: (n) => n === 'OpenKnowledge-arm64.dmg' },
  { platform: 'Windows', arch: 'x64', match: (n) => n === 'OpenKnowledge-Setup-x64.exe' },
  { platform: 'Windows', arch: 'arm64', match: (n) => n === 'OpenKnowledge-Setup-arm64.exe' },
  { platform: 'Debian / Ubuntu', arch: 'x64', match: (n) => n === 'OpenKnowledge-amd64.deb' },
  { platform: 'Debian / Ubuntu', arch: 'arm64', match: (n) => n === 'OpenKnowledge-arm64.deb' },
  { platform: 'Fedora / RHEL', arch: 'x64', match: (n) => n === 'OpenKnowledge-x86_64.rpm' },
  { platform: 'Fedora / RHEL', arch: 'arm64', match: (n) => n === 'OpenKnowledge-aarch64.rpm' },
];

/**
 * Remove the Downloads block (markers + content) from a body. Exported for
 * the consumers that must not carry the table forward —
 * build-slack-release-payload.mjs and aggregate-stable-changelog.mjs keep
 * inlined VARIANTS of this regex (they are fetched/run standalone in
 * workflows, so a cross-file import would break there). Deliberately not
 * byte-identical: this copy alone carries the `\n?` boundary anchors and the
 * `'\n'` replacement, because only the upsert path must keep the
 * strip→re-append cycle byte-stable; the consumers replace with `''` and let
 * their own whitespace collapse absorb the residue. Each site's tests pin
 * its own behavior.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripDownloadsBlock(body) {
  return body.replace(
    /\n?<!-- ok-downloads:start -->[\s\S]*?<!-- ok-downloads:end -->\n?/g,
    '\n',
  );
}

/**
 * @param {{tag: string, repo: string, assetNames: string[]}} input
 * @returns {string|null} The rendered block, or null when no known installer
 *   is present (a body should not gain an empty Downloads section).
 */
export function renderDownloadsBlock({ tag, repo, assetNames }) {
  const rows = ROWS.flatMap((row) => {
    const name = assetNames.find((n) => row.match(n));
    if (!name) return [];
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    return [`| ${row.platform} | ${row.arch} | [${name}](${url}) |`];
  });
  if (rows.length === 0) return null;
  return [
    DOWNLOADS_START,
    '## Downloads',
    '',
    '| Platform | Architecture | Download |',
    '| --- | --- | --- |',
    ...rows,
    DOWNLOADS_END,
  ].join('\n');
}

/**
 * Insert or replace the Downloads block in a release body.
 *
 * The block lands at the END of the body — after the changelog and the
 * consumed-set marker — so everything upstream of it stays byte-identical
 * and position-sensitive readers of the body are unaffected.
 *
 * @param {{body: string, tag: string, repo: string, assetNames: string[]}} input
 * @returns {string} The updated body (unchanged when there is nothing to render).
 */
export function upsertDownloadsBlock({ body, tag, repo, assetNames }) {
  const block = renderDownloadsBlock({ tag, repo, assetNames });
  const withoutOld = stripDownloadsBlock(body);
  if (block == null) return withoutOld === body ? body : withoutOld;
  const trimmed = withoutOld.replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function parseArgs(argv) {
  const args = { tag: '', repo: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tag') args.tag = argv[i + 1] ?? '';
    if (argv[i] === '--repo') args.repo = argv[i + 1] ?? '';
  }
  return args;
}

function main() {
  const { tag, repo } = parseArgs(process.argv.slice(2));
  if (!tag || !repo) {
    process.stderr.write('usage: render-release-downloads.mjs --tag <vX.Y.Z> --repo <owner/name>  (release JSON on stdin)\n');
    process.exitCode = 1;
    return;
  }
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let release;
    try {
      release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      process.stderr.write(`render-release-downloads: stdin is not valid JSON (${error.message})\n`);
      process.exitCode = 1;
      return;
    }
    const body = typeof release.body === 'string' ? release.body : '';
    const assetNames = Array.isArray(release.assets)
      ? release.assets.map((a) => a?.name).filter((n) => typeof n === 'string')
      : [];
    process.stdout.write(upsertDownloadsBlock({ body, tag, repo, assetNames }));
  });
}

// Run main() only as a CLI, not when imported by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
