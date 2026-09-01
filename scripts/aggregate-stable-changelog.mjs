#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const LEVELS = ['Major', 'Minor', 'Patch'];

const LEVEL_HEADING = /^#{2,4} (Major|Minor|Patch) Changes\s*$/;

const STRIP_LINE =
  /^(?:<!-- ok-consumed-set:.*-->|Delta since previous beta\b.*|First beta of the cycle\b.*)\s*$/;

const STRIP_DOWNLOADS_BLOCK = /<!-- ok-downloads:start -->[\s\S]*?<!-- ok-downloads:end -->/g;

export function aggregateStableChangelog(input) {
  const withoutDownloads = input.replace(STRIP_DOWNLOADS_BLOCK, '');
  const buckets = { Major: [], Minor: [], Patch: [] };
  let level = null;
  let block = null;

  const flush = () => {
    if (level && block) {
      while (block.length && block[block.length - 1].trim() === '') block.pop();
      if (block.length) buckets[level].push(block.join('\n'));
    }
    block = null;
  };

  for (const line of withoutDownloads.split('\n')) {
    if (STRIP_LINE.test(line)) continue;
    const heading = LEVEL_HEADING.exec(line);
    if (heading) {
      flush();
      level = heading[1];
      continue;
    }
    if (line.startsWith('- ')) {
      flush();
      block = [line];
      continue;
    }
    if (block) block.push(line);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
