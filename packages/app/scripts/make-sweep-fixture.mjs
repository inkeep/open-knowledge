#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXABLE_BLOCKS = [
  (i) => `Paragraph ${i} carries a single trailing space. `,
  (i) => `Paragraph ${i}\tcontains a hard tab character.`,
  (i) => `##Section ${i} heading without a space after the hash`,
  (i) => `##  Section ${i} heading with two spaces after the hash`,
];

const NON_FIXABLE_BLOCKS = [
  (i) => `\`\`\`\nplain fenced block ${i} with no language\n\`\`\``,
  (i) => `Paragraph ${i} links to [nothing here]().`,
  (i) => `Paragraph ${i} shows ![](/assets/diagram-${i}.png) inline.`,
];

const FILLER = [
  'This paragraph is ordinary prose and carries no lint findings at all.',
  'It exists so the document has enough body to look like real content.',
  'Nothing here should trip a rule; it is deliberately unremarkable text.',
  'The corpus needs bulk so the audit walk and the render both do real work.',
];

function buildDoc(index, fixableCount, brokenCount, fillerParas, rng) {
  const lines = [];
  lines.push('---');
  lines.push(`index: ${index}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Document ${index}`);
  lines.push('');
  lines.push(FILLER[index % FILLER.length]);
  lines.push('');

  const blocks = [];
  for (let i = 0; i < fixableCount; i++) {
    const pick = FIXABLE_BLOCKS[Math.floor(rng() * FIXABLE_BLOCKS.length)];
    blocks.push(pick(index * 100 + i));
  }
  for (let i = 0; i < brokenCount; i++) {
    const pick = NON_FIXABLE_BLOCKS[Math.floor(rng() * NON_FIXABLE_BLOCKS.length)];
    blocks.push(pick(index * 100 + i));
  }
  for (let i = 0; i < fillerParas; i++) {
    blocks.push(FILLER[(index + i) % FILLER.length]);
  }

  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }

  for (const block of blocks) {
    lines.push(block);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

const PRESETS = {
  realistic: {
    docs: 2400,
    cleanDocs: 59,
    fixableDocs: 2083,
    fixablePerDoc: [1, 4],
    brokenPerDoc: [1, 2],
    fillerParas: [3, 8],
  },
  small: {
    docs: 36,
    cleanDocs: 24,
    fixableDocs: 6,
    fixablePerDoc: [1, 4],
    brokenPerDoc: [1, 2],
    fillerParas: [2, 5],
  },
  subchunk: {
    docs: 45,
    cleanDocs: 0,
    fixableDocs: 45,
    fixablePerDoc: [18, 26],
    brokenPerDoc: [0, 1],
    fillerParas: [40, 60],
  },
};

function numericFlag(name, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`error: ${name} must be a positive number (got: ${JSON.stringify(raw)})`);
    process.exit(2);
  }
  return n;
}

const argv = process.argv.slice(2);
let preset = null;
let outDir = null;
let docsOverride = null;
let seed = 7714;
let force = false;
let quiet = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--preset') preset = argv[++i];
  else if (arg === '--out') outDir = argv[++i];
  else if (arg === '--docs') docsOverride = numericFlag('--docs', argv[++i]);
  else if (arg === '--seed') seed = numericFlag('--seed', argv[++i]);
  else if (arg === '--force') force = true;
  else if (arg === '--quiet') quiet = true;
  else if (arg === '-h' || arg === '--help') {
    console.log(
      'usage: make-sweep-fixture.mjs --preset <realistic|small|subchunk> --out <dir> [--seed N] [--force]',
    );
    process.exit(0);
  } else {
    console.error(`error: unknown flag: ${arg}`);
    process.exit(2);
  }
}

if (!preset || !PRESETS[preset]) {
  console.error(`error: --preset must be one of: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(2);
}
if (!outDir) {
  console.error('error: --out <dir> is required');
  process.exit(2);
}

outDir = resolve(outDir.replace(/^~(?=$|\/)/, homedir()));

const FIXTURE_MARKER = '.ok-sweep-fixture';

if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  if (!force) {
    console.error(`error: ${outDir} exists and is not empty (pass --force to overwrite)`);
    process.exit(2);
  }
  if (existsSync(join(outDir, '.git'))) {
    console.error(
      `error: refusing --force on ${outDir} — it contains a .git directory.\n` +
        '       This script deletes its target recursively; that looks like a real checkout.',
    );
    process.exit(2);
  }
  if (!existsSync(join(outDir, FIXTURE_MARKER))) {
    console.error(
      `error: refusing --force on ${outDir} — no ${FIXTURE_MARKER} marker found.\n` +
        '       --force only overwrites corpora this script generated. Delete the\n' +
        '       directory by hand if you really mean to replace it.',
    );
    process.exit(2);
  }
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, FIXTURE_MARKER),
  'Generated by packages/app/scripts/make-sweep-fixture.mjs. Safe for --force to replace.\n',
  'utf8',
);

const cfg = { ...PRESETS[preset] };
if (docsOverride !== null) cfg.docs = docsOverride;

const rng = makeRng(seed);
const pickRange = ([lo, hi]) => lo + Math.floor(rng() * (hi - lo + 1));

const roles = [];
for (let i = 0; i < cfg.docs; i++) {
  if (i < cfg.cleanDocs) roles.push('clean');
  else if (i < cfg.cleanDocs + cfg.fixableDocs) roles.push('fixable');
  else roles.push('broken-only');
}
for (let i = roles.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [roles[i], roles[j]] = [roles[j], roles[i]];
}

const PER_DIR = 50;
let written = 0;

for (let i = 0; i < cfg.docs; i++) {
  const role = roles[i];
  const fixableCount = role === 'fixable' ? pickRange(cfg.fixablePerDoc) : 0;
  const brokenCount = role === 'clean' ? 0 : pickRange(cfg.brokenPerDoc);
  const fillerParas = pickRange(cfg.fillerParas);

  const body = buildDoc(i, fixableCount, brokenCount, fillerParas, rng);

  const bucket = `section-${String(Math.floor(i / PER_DIR)).padStart(3, '0')}`;
  const dir = join(outDir, bucket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `doc-${String(i).padStart(5, '0')}.md`), body, 'utf8');
  written++;
}

mkdirSync(join(outDir, '.ok'), { recursive: true });
writeFileSync(
  join(outDir, '.ok', 'config.yml'),
  [
    '# Generated by make-sweep-fixture.mjs — do not hand-edit.',
    'contentRules:',
    '  markdownlint:',
    '    enabled: true',
    '',
  ].join('\n'),
  'utf8',
);

if (!quiet) {
  const counts = {};
  for (const role of roles) counts[role] = (counts[role] ?? 0) + 1;
  console.log(`[make-sweep-fixture] preset=${preset} seed=${seed}`);
  console.log(`  out:          ${outDir}`);
  console.log(`  docs written: ${written}`);
  console.log(`  clean:        ${counts.clean ?? 0}`);
  console.log(`  fixable:      ${counts.fixable ?? 0}`);
  console.log(`  broken-only:  ${counts['broken-only'] ?? 0}`);
  console.log('');
  console.log('  Verify the finding counts against a running server:');
  console.log(`    ok start --port 7801   # cwd = a COPY of ${outDir}`);
  console.log('    curl -s localhost:<api-port>/api/audit | jq ...');
}
