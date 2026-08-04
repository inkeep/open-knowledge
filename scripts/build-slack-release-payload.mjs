#!/usr/bin/env node
/**
 * Build the Slack Block Kit payload announcing a stable release, with the
 * release notes inlined so the channel reads what shipped without clicking
 * through to GitHub.
 *
 * Two things make this more than a jq one-liner, which is why it lives in a
 * tested script rather than inline in the workflow:
 *
 *   1. Slack mrkdwn is not GitHub markdown. `### Patch Changes` renders as a
 *      literal `###`, `**bold**` as literal asterisks, and `[text](url)` as
 *      literal brackets. Release bodies are Changesets output, so they always
 *      carry level headings and usually links/bold — posting them raw looks
 *      broken.
 *   2. A section block's text caps at 3000 characters and release bodies run
 *      past 6000 on a minor. Overflowing the cap is a hard 400 from Slack, so
 *      the notes are truncated to a budget and split across sections at line
 *      boundaries.
 *
 * Usage:
 *   gh release view "$TAG" --json body --jq '.body' \
 *     | node scripts/build-slack-release-payload.mjs --version 0.38.4 --url https://…
 *
 * Emits the payload JSON on stdout. Empty/missing notes on stdin degrade to
 * the header + link message this replaced, so a failed `gh release view` still
 * announces the release. Pure text transform; no network.
 */
import { pathToFileURL } from 'node:url';

// A section block's `text.text` caps at 3000 chars (Slack rejects the whole
// message otherwise). Chunk below the cap so a multi-byte tail can't straddle
// it.
const SECTION_LIMIT = 2900;

// Total notes budget across all sections. Matches the Discord announcement's
// limit so both channels show the same amount of a long release body; the
// remainder is a click away behind the link block.
const NOTES_LIMIT = 3500;

/** Slack requires these three escaped in mrkdwn text. */
function escapeSlackText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert GitHub markdown to Slack mrkdwn.
 *
 * Runs line-by-line so fenced code blocks can be passed through untouched —
 * rewriting `*`/`[]` inside a fence would corrupt the sample it is quoting.
 *
 * @param {string} markdown Release body as authored by Changesets.
 * @returns {string} mrkdwn-formatted equivalent.
 */
export function githubMarkdownToSlackMrkdwn(markdown) {
  // Strip the Downloads table desktop-release.yml renders into the body —
  // CONTENT included, which the comment-strip below can't do (it only
  // removes the marker lines, leaving the table itself; Slack mrkdwn has no
  // tables, so it would render as pipe soup). Simplified variant of
  // render-release-downloads.mjs's stripDownloadsBlock (inlined because this
  // script is fetched standalone in workflows): the `\n?` boundary anchors
  // and `'\n'` replacement are deliberately omitted — only the upsert path
  // needs byte-stable strip→re-append; the `\n{3,}` collapse below absorbs
  // the residue here. Each side's tests pin its own behavior.
  const withoutDownloads = markdown.replace(
    /<!-- ok-downloads:start -->[\s\S]*?<!-- ok-downloads:end -->/g,
    '',
  );
  // Strip HTML comments next: the beta cadence embeds an internal
  // `<!-- ok-consumed-set: … -->` marker that must never reach the channel.
  const withoutComments = withoutDownloads.replace(/<!--[\s\S]*?-->/g, '');

  let inFence = false;
  const lines = withoutComments.split('\n').map((rawLine) => {
    // Escape before any conversion so a literal `<` in prose cannot be read as
    // the start of a Slack link, and so the `<url|label>` links built below
    // survive (escaping only touches & < >, never [ ] ( )).
    const line = escapeSlackText(rawLine);

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    // Headings have no mrkdwn equivalent; bold carries the same visual weight.
    const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*$/);
    if (heading) return heading[1] ? `*${heading[1]}*` : '';

    let out = line;

    // Bullets: mrkdwn has no list syntax, so render the glyph literally.
    // Changesets nests one level (two-space indent) for sub-points.
    const bullet = out.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const glyph = depth === 0 ? '•' : '◦';
      out = `${'    '.repeat(depth)}${glyph} ${bullet[2]}`;
    }

    // `[label](url)` -> `<url|label>`. Label excludes `]` and the URL excludes
    // `)` and whitespace so adjacent links on one line stay separate matches.
    out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label, url) =>
      label ? `<${url}|${label}>` : `<${url}>`,
    );

    // `**bold**` / `__bold__` -> `*bold*`. Single-asterisk emphasis is left
    // alone: Slack reads it as bold, which is a closer render than the literal
    // asterisks any rewrite would risk producing.
    out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '*$1*');
    out = out.replace(/__(?=\S)([\s\S]*?\S)__/g, '*$1*');

    return out;
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Truncate to `limit` characters on a line boundary, marking the cut.
 *
 * Cutting mid-line would risk splitting a `<url|label>` link into visible
 * syntax, so a too-long single line is dropped rather than sliced.
 *
 * @returns {string} Text at or under the limit, `…` appended when truncated.
 */
export function truncateOnLineBoundary(text, limit) {
  if (text.length <= limit) return text;
  const kept = [];
  let used = 0;
  for (const line of text.split('\n')) {
    // +1 for the newline that rejoins this line to the previous one.
    const cost = line.length + (kept.length === 0 ? 0 : 1);
    if (used + cost > limit) break;
    kept.push(line);
    used += cost;
  }
  return `${kept.join('\n').trimEnd()}\n…`;
}

/**
 * Split text into chunks that each fit a section block, preferring paragraph
 * then line boundaries so a chunk never starts mid-sentence.
 *
 * @returns {string[]} Chunks, each at or under `limit`.
 */
export function chunkForSections(text, limit = SECTION_LIMIT) {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // A single line over the limit cannot be kept whole; hard-slice it so the
    // message still sends rather than 400s.
    if (line.length > limit) {
      let rest = line;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      current = rest;
    } else {
      current = line;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim() !== '');
}

/**
 * @param {{version: string, releaseUrl: string, notes?: string}} input
 * @returns {object} Slack incoming-webhook payload.
 */
export function buildSlackReleasePayload({ version, releaseUrl, notes = '' }) {
  const mrkdwn = truncateOnLineBoundary(githubMarkdownToSlackMrkdwn(notes ?? ''), NOTES_LIMIT);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎉 OpenKnowledge ${version} released`, emoji: true },
    },
    ...chunkForSections(mrkdwn).map((chunk) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk },
    })),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*<${releaseUrl}|Release notes & downloads>*` },
    },
  ];

  return {
    // Notification/a11y fallback Slack recommends alongside blocks.
    text: `OpenKnowledge ${version} released — ${releaseUrl}`,
    blocks,
  };
}

function parseArgs(argv) {
  const args = { version: '', releaseUrl: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') args.version = argv[i + 1] ?? '';
    if (argv[i] === '--url') args.releaseUrl = argv[i + 1] ?? '';
  }
  return args;
}

function main() {
  const { version, releaseUrl } = parseArgs(process.argv.slice(2));
  if (!version || !releaseUrl) {
    process.stderr.write('usage: build-slack-release-payload.mjs --version <v> --url <url>\n');
    process.exitCode = 1;
    return;
  }
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const notes = Buffer.concat(chunks).toString('utf8');
    process.stdout.write(JSON.stringify(buildSlackReleasePayload({ version, releaseUrl, notes })));
  });
}

// Run main() only as a CLI, not when imported by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
