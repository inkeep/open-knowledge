#!/usr/bin/env node
//
// make-sweep-fixture.mjs — generate the content fixtures the sweep measurement
// and manual QA run against.
//
// Why this exists
// ---------------
// `measure-sweep.sh` and the Fix-all QA scenarios both need a large corpus with
// a known number of fixable lint findings. Those corpora used to be hand-built
// outside the repo, which made `pnpm run measure:sweep` reproducible only on the
// machine that happened to still have them. This script makes the fixture a
// derived artifact: same seed in, same corpus out, on any machine.
//
// Output is a plain content directory — no `.ok/`, no git. The consumer copies
// it to a scratch dir and points a server at the copy.
//
// Usage
// -----
//   node scripts/make-sweep-fixture.mjs --preset realistic --out ~/ok-validation/realistic
//   node scripts/make-sweep-fixture.mjs --preset small     --out ~/ok-validation/small
//   node scripts/make-sweep-fixture.mjs --preset subchunk  --out ~/ok-validation/subchunk
//
// Flags
// -----
//   --preset NAME   realistic | small | subchunk  (required unless --docs given)
//   --out DIR       destination directory (required). Refuses a non-empty dir
//                   unless --force.
//   --docs N        override the preset's document count.
//   --seed N        PRNG seed (default 7714) — same seed, same corpus.
//   --force         replace a non-empty directory. Refuses unless the target
//                   carries this script's `.ok-sweep-fixture` marker and has no
//                   `.git` — a mistyped --out must not delete real work.
//   --quiet         suppress the per-preset summary.
//
// Presets
// -------
//   realistic  2,400 docs shaped to match the corpus the spec's §7 numbers were
//              measured on: ~2,341 docs carrying at least one finding, ~2,083 of
//              those carrying at least one FIXABLE finding, ~8,300 findings total.
//   small      36 docs, 6 of them fixable — the "small project" QA fixture.
//   subchunk   45 docs, all fixable, deliberately long so a sub-chunk sweep still
//              takes multiple seconds (the progress-visibility scenario).
//
// No wiki-links are emitted. The corpus is intentionally link-free: the doc-scoped
// audit walks the backward link index, so a link-dense corpus measures the link
// graph rather than the sweep.
//
// Calibration
// -----------
// `realistic` was tuned against a real `GET /api/audit` rather than by reasoning
// about which rules fire. Measured at seed 7714:
//
//   docs scanned 2400 · groups 2341 · fixable files 2083 · findings 8734 · 2.31 MB
//
// The first three are exact (they follow from role assignment) and are what drive
// render cost; the finding total runs ~5% above the 8,304 of the corpus the spec's
// §7 numbers came from, and the response size matches its stated 2.3 MB.
//
// Two calibration findings are baked into the emitters below, both of which had
// silently inflated an earlier draft of this corpus:
//   - a frontmatter `title:` makes MD025 fire on EVERY document, so no document is
//     ever genuinely clean (see buildDoc);
//   - a heading block deeper than the document's h1 trips MD001 as collateral.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// ── PRNG (mulberry32) — deterministic across platforms/Node versions ─────────
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

// ── Violation blocks ────────────────────────────────────────────────────────
// Each block is written to yield exactly ONE finding, and is separated from its
// neighbours by blank lines so heading/list spacing rules (MD022/MD031/MD032)
// do not fire as collateral and inflate the count. The `fixable` flag records
// whether markdownlint ships an autofix for that rule — the sweep only acts on
// findings that carry one, so the two groups are what make a doc land in the
// "fixable" bucket or merely the "has problems" bucket.

const FIXABLE_BLOCKS = [
  // MD009 — trailing spaces (one trailing space; br_spaces default of 2 makes a
  // 2-space line a legal hard break, so one space is the unambiguous violation).
  (i) => `Paragraph ${i} carries a single trailing space. `,
  // MD010 — hard tabs.
  (i) => `Paragraph ${i}\tcontains a hard tab character.`,
  // MD018 — no space after hash in an ATX heading. Level 2, so it does not trip
  // MD001 (heading-increment) against the document's h1.
  (i) => `##Section ${i} heading without a space after the hash`,
  // MD019 — multiple spaces after hash. Level 2 for the same reason.
  (i) => `##  Section ${i} heading with two spaces after the hash`,
];

const NON_FIXABLE_BLOCKS = [
  // MD040 — fenced code block without a language.
  (i) => `\`\`\`\nplain fenced block ${i} with no language\n\`\`\``,
  // MD042 — empty link.
  (i) => `Paragraph ${i} links to [nothing here]().`,
  // MD045 — image with no alternate text.
  (i) => `Paragraph ${i} shows ![](/assets/diagram-${i}.png) inline.`,
];

const FILLER = [
  'This paragraph is ordinary prose and carries no lint findings at all.',
  'It exists so the document has enough body to look like real content.',
  'Nothing here should trip a rule; it is deliberately unremarkable text.',
  'The corpus needs bulk so the audit walk and the render both do real work.',
];

/**
 * Build one document.
 *
 * @param index        doc number, used for stable titles/paths
 * @param fixableCount how many fixable-rule blocks to inject
 * @param brokenCount  how many non-fixable-rule blocks to inject
 * @param fillerParas  how many clean paragraphs to pad with
 * @param rng          seeded PRNG
 */
function buildDoc(index, fixableCount, brokenCount, fillerParas, rng) {
  const lines = [];
  // No `title:` key: MD025's front_matter_title default treats a frontmatter
  // title as the document's top-level heading, which would make the `# ...`
  // below a second h1 and fire MD025 on EVERY doc — including the ones this
  // fixture needs to be genuinely clean.
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

  // Shuffle so violations are not all clustered at the top of every doc.
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }

  for (const block of blocks) {
    lines.push(block);
    lines.push('');
  }

  // Trailing newline is present, so MD047 does not fire as an uncounted extra.
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ── Presets ─────────────────────────────────────────────────────────────────
// `fixablePerDoc` / `brokenPerDoc` are ranges [min, max] inclusive.
const PRESETS = {
  realistic: {
    docs: 2400,
    cleanDocs: 59, // 2400 - 2341 docs-with-problems
    fixableDocs: 2083, // of the 2,341 with problems, these carry an autofixable one
    // Calibrated against the real audit: each block yields ~1 finding, so
    // 2,083 × ~2.5 + 2,341 × ~1.5 lands near the 8,304 the spec's §7 corpus had.
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

// ── Arg parsing ─────────────────────────────────────────────────────────────

/**
 * Reject a non-numeric or non-positive flag value instead of letting it become
 * NaN. `Number('abc')` is NaN, which silently degrades two different ways: as
 * `--docs` it makes the generation loop never iterate, so the script writes only
 * `.ok/config.yml` and still exits 0; as `--seed` it becomes 0 via `NaN >>> 0`,
 * quietly breaking the same-seed-same-corpus contract this file promises. The
 * shell siblings reject the same shape (`assert_numeric_flag` in _measure-lib.sh).
 */
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

// Marker this script drops into every corpus it generates. `--force` will only
// delete a directory carrying it, so a mistyped --out (the parent
// ~/ok-validation, or `.` from inside a checkout) fails loudly instead of
// recursively destroying someone's work. The documented invocations re-target
// directories this script itself produced, so they keep working unchanged.
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

// ── Generate ────────────────────────────────────────────────────────────────
const cfg = { ...PRESETS[preset] };
if (docsOverride !== null) cfg.docs = docsOverride;

const rng = makeRng(seed);
const pickRange = ([lo, hi]) => lo + Math.floor(rng() * (hi - lo + 1));

// Assign each doc a role up front, then shuffle so the roles are not contiguous
// (a contiguous block of clean docs would sort to one end of the panel).
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

// Spread docs over subdirectories so the tree resembles a real KB rather than
// one flat directory of several thousand entries.
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

// A fixture is only usable if a server will actually lint it. `ok init` writes a
// config whose keys are all commented out, and the markdownlint plugin defaults
// to disabled — so a fixture without this file audits to zero findings and looks
// like a passing sweep of nothing.
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
