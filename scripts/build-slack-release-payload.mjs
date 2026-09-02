#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const SECTION_LIMIT = 2900;

const NOTES_LIMIT = 3500;

function escapeSlackText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function githubMarkdownToSlackMrkdwn(markdown) {
  const withoutDownloads = markdown.replace(
    /<!-- ok-downloads:start -->[\s\S]*?<!-- ok-downloads:end -->/g,
    '',
  );
  const withoutComments = withoutDownloads.replace(/<!--[\s\S]*?-->/g, '');

  let inFence = false;
  const lines = withoutComments.split('\n').map((rawLine) => {
    const line = escapeSlackText(rawLine);

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*$/);
    if (heading) return heading[1] ? `*${heading[1]}*` : '';

    let out = line;

    const bullet = out.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const glyph = depth === 0 ? '•' : '◦';
      out = `${'    '.repeat(depth)}${glyph} ${bullet[2]}`;
    }

    out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label, url) =>
      label ? `<${url}|${label}>` : `<${url}>`,
    );

    out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '*$1*');
    out = out.replace(/__(?=\S)([\s\S]*?\S)__/g, '*$1*');

    return out;
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function truncateOnLineBoundary(text, limit) {
  if (text.length <= limit) return text;
  const kept = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const cost = line.length + (kept.length === 0 ? 0 : 1);
    if (used + cost > limit) break;
    kept.push(line);
    used += cost;
  }
  return `${kept.join('\n').trimEnd()}\n…`;
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
