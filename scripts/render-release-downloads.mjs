#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const DOWNLOADS_START = '<!-- ok-downloads:start -->';
export const DOWNLOADS_END = '<!-- ok-downloads:end -->';

const ROWS = [
  { platform: 'macOS', arch: 'Apple Silicon', match: (n) => n === 'OpenKnowledge-arm64.dmg' },
  { platform: 'Windows', arch: 'x64', match: (n) => n === 'OpenKnowledge-Setup-x64.exe' },
  { platform: 'Windows', arch: 'arm64', match: (n) => n === 'OpenKnowledge-Setup-arm64.exe' },
  { platform: 'Debian / Ubuntu', arch: 'x64', match: (n) => n === 'OpenKnowledge-amd64.deb' },
  { platform: 'Debian / Ubuntu', arch: 'arm64', match: (n) => n === 'OpenKnowledge-arm64.deb' },
  { platform: 'Fedora / RHEL', arch: 'x64', match: (n) => n === 'OpenKnowledge-x86_64.rpm' },
  { platform: 'Fedora / RHEL', arch: 'arm64', match: (n) => n === 'OpenKnowledge-aarch64.rpm' },
];

export function stripDownloadsBlock(body) {
  return body.replace(
    /\n?<!-- ok-downloads:start -->[\s\S]*?<!-- ok-downloads:end -->\n?/g,
    '\n',
  );
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
