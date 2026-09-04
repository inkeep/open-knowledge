#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePoCatalog,
  requiredPluralCategories,
  SOURCE_LOCALE,
} from './check-i18n-new-string-translations.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALES_TS = 'packages/core/src/i18n/locales.ts';
const GLOSSARY_MD = 'packages/app/src/locales/GLOSSARY.md';
const REVIEW_MD = 'packages/app/src/locales/REVIEW.md';
const CATALOG_REL = (locale) => `packages/app/src/locales/${locale}/messages.po`;

export const TARGET_MESSAGES = 100;

export const MAX_PER_GLOSSARY_TERM = 3;

export const CHROME_SURFACES = [
  {
    label: 'Preferences, where the language picker lives',
    why: 'The one screen a reader of this language is guaranteed to have visited, since it is where they chose the language.',
    files: [
      'src/components/settings/LanguageSelect.tsx',
      'src/components/settings/settings-fields.ts',
      'src/components/settings/field-controls.tsx',
    ],
  },
  {
    label: 'Menu bar',
    why: 'Always on screen, and the vocabulary every other surface is read against.',
    files: ['src/lib/native-menu-catalog.ts', 'src/components/AppMenubar.tsx'],
  },
  {
    label: 'Command palette and keyboard shortcuts',
    why: 'The fastest path to every action in the app, so its labels are read more often than the buttons they duplicate.',
    files: [
      'src/components/CommandPalette.tsx',
      'src/components/command-palette-commands.ts',
      'src/lib/keyboard-shortcuts.ts',
    ],
  },
  {
    label: 'Files and navigation',
    why: 'Permanently on screen beside the document, and where the glossary nouns for document and folder are load-bearing.',
    files: ['src/components/FileTree.tsx', 'src/components/FileSidebar.tsx'],
  },
  {
    label: 'Settings',
    why: 'Where a user goes when something is wrong, which is the worst moment to meet unclear copy.',
    files: ['src/components/settings/SettingsDialogShell.tsx'],
  },
];

export function readLocaleTuple(source, name) {
  const block = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!block) {
    throw new Error(`Could not find a ${name} array in ${LOCALES_TS}`);
  }
  const tags = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (tags.length === 0) {
    throw new Error(`${name} in ${LOCALES_TS} parsed as empty`);
  }
  return tags;
}

export function parsePoEntries(text) {
  const entries = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const parsed = parsePoCatalog(block);
    const [first] = [...parsed.entries()];
    if (!first) continue;
    const [id, str] = first;
    const references = [];
    for (const line of block.split('\n')) {
      const ref = /^#:\s*(.+)$/.exec(line.trim());
      if (ref) references.push(...ref[1].trim().split(/\s+/));
    }
    entries.push({ id, str, references });
  }
  return entries;
}

export function readGlossaryTerms(markdown, locale) {
  const terms = [];
  let headers = null;
  let column = -1;

  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      headers = null;
      column = -1;
      continue;
    }
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    if (!headers) {
      headers = cells.map((cell) => cell.replace(/`/g, ''));
      column = headers.indexOf(locale);
      continue;
    }
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (column > 0 && cells[column]) {
      terms.push({ term: cells[0], translation: cells[column] });
    }
  }
  return terms;
}

export function readSection(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

export function readReviewStatus(markdown) {
  const rows = new Map();
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const match = /^\|\s*`([^`]+)`\s*\|(.*)\|?$/.exec(line);
    if (!match) continue;
    const cells = match[2].split('|').map((cell) => cell.trim());
    const [language, status, basis, evidence, blocker] = cells;
    rows.set(match[1], {
      language: language ?? '',
      status: (status ?? '').toLowerCase(),
      basis: basis ?? '',
      evidence: evidence ?? '',
      blocker: blocker ?? '',
    });
  }
  return rows;
}

function termPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\p{L})${escaped}s?(?!\\p{L})`, 'iu');
}

function byLeverage(a, b) {
  const lengthDelta = (a.source ?? '').length - (b.source ?? '').length;
  return lengthDelta !== 0 ? lengthDelta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function selectMessages({
  entries,
  translations,
  glossaryTerms,
  surfaces = CHROME_SURFACES,
  target = TARGET_MESSAGES,
  maxPerTerm = MAX_PER_GLOSSARY_TERM,
}) {
  const candidates = entries.map((entry) => ({
    id: entry.id,
    source: entry.str || entry.id,
    translation: translations.get(entry.id) ?? '',
    references: entry.references,
  }));
  const chosen = new Set();

  const glossaryUses = [];
  for (const { term, translation } of glossaryTerms) {
    const pattern = termPattern(term);
    const uses = candidates
      .filter((candidate) => !chosen.has(candidate.id) && pattern.test(candidate.source))
      .sort(byLeverage)
      .slice(0, maxPerTerm);
    for (const use of uses) chosen.add(use.id);
    glossaryUses.push({ term, translation, uses });
  }

  const queues = surfaces.map((surface) => ({
    surface,
    remaining: candidates
      .filter(
        (candidate) =>
          !chosen.has(candidate.id) &&
          candidate.references.some((ref) => surface.files.includes(ref)),
      )
      .sort(byLeverage),
    picked: [],
  }));

  let budget = Math.max(0, target - chosen.size);
  let progressed = true;
  while (budget > 0 && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (budget === 0) break;
      let next = queue.remaining.shift();
      while (next && chosen.has(next.id)) next = queue.remaining.shift();
      if (!next) continue;
      queue.picked.push(next);
      chosen.add(next.id);
      budget--;
      progressed = true;
    }
  }

  return {
    glossaryUses,
    surfaces: queues.map(({ surface, picked }) => ({ surface, messages: picked })),
  };
}

const oneLine = (text) => text.replace(/\r?\n/g, ' ⏎ ').trim();

function renderMessage(number, locale, message) {
  return [
    `**${number}.**`,
    `- \`en\` — ${oneLine(message.source)}`,
    `- \`${locale}\` — ${oneLine(message.translation) || '_(empty — nothing to review here yet)_'}`,
  ].join('\n');
}

function endonym(locale) {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function stakes({ offered, promotable }) {
  if (offered) {
    return '- **If you approve:** nothing changes on screen — the language is already offered. What changes is that it is offered because someone read it, rather than because nobody had reason to doubt it. Corrections are the expected answer and land as ordinary edits; if you tell us it is not usable as it stands, we take it out of the picker.';
  }
  if (promotable) {
    return '- **If you approve:** the language is added to the in-app language picker and users can select it.';
  }
  return '- **If you approve:** the catalog is marked reviewed, but the language still will not appear in the picker yet. Its right-to-left layout is unfinished, and offering a language the app lays out wrongly is not something a translation can fix. Your review is what makes it ready for the moment that work lands, and it is not wasted — but you should know it before spending the hour.';
}

export function buildPacket({
  locale,
  status,
  offered,
  promotable,
  catalogStamp,
  messageCount,
  glossaryTerms,
  neverTranslated,
  selection,
}) {
  const lines = [];
  const push = (...text) => lines.push(...text, '');
  let number = 0;

  const name = endonym(locale);
  push(`# Reviewing OpenKnowledge in ${name} (\`${locale}\`)`);
  push(
    offered
      ? [
          `OpenKnowledge's interface has been translated into ${name} by a coding agent working against`,
          'a locked vocabulary, and the app already offers the language. What it has never had is a',
          'reader: nobody who reads it has checked whether the words are right. You are being asked to',
          'read a sample and say whether it is good enough to keep offering.',
        ].join('\n')
      : [
          `OpenKnowledge's interface has been translated into ${name} by a coding agent working against`,
          'a locked vocabulary. Nobody who reads the language has read it yet, which is why the language',
          "is not offered in the app's language picker. You are being asked to read a sample of it and",
          'say whether it is fit to offer.',
        ].join('\n'),
  );
  push(
    'You do not need the app, a checkout, or any tooling. Everything you need is in this file.',
    'It should take under an hour.',
  );

  push('## What we are asking');
  push(
    '1. Read section 1, the locked vocabulary. It is under ten words and it matters more than',
    '   everything else here put together, because each one is enforced across every message',
    '   that uses it.',
    '2. Skim sections 2 and 3. Each string is numbered.',
    '3. Send back the numbers you would change and what they should say. Prose is fine; a list',
    '   of `17 → <better wording>` is ideal. "The rest reads fine" is a real and useful answer.',
  );
  push(
    'Judge it as a native reader of software, not as a translator grading a translation. The',
    'question is whether someone using the app in this language would trust it, not whether',
    'each line is the best possible rendering.',
  );

  push('## Before you start');
  push(
    `- **Current state:** ${status.status || 'unknown'}${status.basis && status.basis !== '—' ? ` — ${status.basis}` : ''}.`,
    `- **Catalog:** ${messageCount} messages, extracted ${catalogStamp}. This packet samples about ${TARGET_MESSAGES} of them; the rule is at the bottom.`,
    `- **Plural forms this language needs:** ${requiredPluralCategories(locale).join(', ')}.`,
    stakes({ offered, promotable }),
  );
  push(
    'Placeholders like `{name}`, `{count}` and `#` are substituted at runtime. They must survive',
    'unchanged and untranslated; word order around them can move freely. `⏎` marks a line break',
    'inside a message.',
  );

  push('## 1. The locked vocabulary');
  push(
    'These words are pinned. Every message that mentions the concept uses the pinned form, and',
    'CI enforces it. A wrong entry here is the single most expensive kind of mistake in this',
    'catalog, and the cheapest to catch — so read this table twice and the rest once.',
  );
  push(
    `| Concept (English) | Current \`${locale}\` |`,
    '| --- | --- |',
    ...glossaryTerms.map(({ term, translation }) => `| ${term} | ${translation} |`),
  );
  if (neverTranslated) {
    push('### These are deliberately never translated', neverTranslated);
  }

  push('## 2. The vocabulary in use');
  push(
    'The same words in real messages. Terminology drift is invisible to every automated check —',
    'a catalog that renders one concept three different ways is still complete and still passes',
    'CI — so this is the section only you can review.',
  );
  for (const { term, translation, uses } of selection.glossaryUses) {
    push(`### ${term} → ${translation}`);
    if (uses.length === 0) {
      push(
        'No interface message uses this word today, so there is nothing to read it in context.',
        'Judge the table entry above on its own.',
      );
      continue;
    }
    for (const message of uses) {
      number += 1;
      push(renderMessage(number, locale, message));
    }
  }

  push('## 3. The interface');
  push('The surfaces a user meets most often, in the order they meet them.');
  for (const { surface, messages } of selection.surfaces) {
    if (messages.length === 0) continue;
    push(`### ${surface.label}`, `_${surface.why}_`);
    for (const message of messages) {
      number += 1;
      push(renderMessage(number, locale, message));
    }
  }

  push('## How this sample was chosen');
  push(
    `${number} strings out of ${messageCount}, chosen by a fixed rule rather than at random, so`,
    'the same numbers mean the same strings if we send you an updated packet:',
    '',
    '1. Every locked vocabulary word.',
    `2. Up to ${MAX_PER_GLOSSARY_TERM} messages using each of those words, shortest first.`,
    '3. The interface surfaces above, filled evenly between them, shortest first.',
  );
  push(
    'Shortest first on purpose: a short label carries its meaning alone, while a paragraph',
    'explains itself even when a word inside it is off. The short ones are where a wrong word',
    'does the most damage.',
  );
  push(
    'What this sample cannot tell us is whether the other ~2,800 messages are good. It tells us',
    'whether the vocabulary and the surfaces people actually live in are good, which is the part',
    "worth an hour of a native reader's time. If this sample reads badly, that is a strong",
    'signal about the whole catalog.',
  );

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

export function generate({ locale, root = OK_ROOT }) {
  const localesSource = readFileSync(join(root, LOCALES_TS), 'utf8');
  const supported = readLocaleTuple(localesSource, 'SUPPORTED_LOCALES');
  const picker = readLocaleTuple(localesSource, 'PICKER_LOCALES');
  const layoutDeferred = readLocaleTuple(localesSource, 'LAYOUT_DEFERRED_LOCALES');

  if (!supported.includes(locale)) {
    throw new Error(
      `${locale} is not an enumerated locale. ${LOCALES_TS} lists: ${supported.join(', ')}`,
    );
  }
  if (locale === SOURCE_LOCALE) {
    throw new Error(
      `${SOURCE_LOCALE} is the source catalog — its translation is the English text itself, so there is nothing to review.`,
    );
  }

  const reviewStatus = readReviewStatus(readFileSync(join(root, REVIEW_MD), 'utf8'));
  const status = reviewStatus.get(locale);
  if (!status) {
    throw new Error(
      `${locale} has no row in ${REVIEW_MD}. Add one before generating a packet — an untracked review is a review nobody can find again.`,
    );
  }

  const catalogPath = join(root, CATALOG_REL(locale));
  if (!existsSync(catalogPath)) {
    throw new Error(`No catalog at ${CATALOG_REL(locale)}`);
  }

  const sourceText = readFileSync(join(root, CATALOG_REL(SOURCE_LOCALE)), 'utf8');
  const entries = parsePoEntries(sourceText);
  const translations = parsePoCatalog(readFileSync(catalogPath, 'utf8'));

  const glossary = readFileSync(join(root, GLOSSARY_MD), 'utf8');
  const glossaryTerms = readGlossaryTerms(glossary, locale);
  if (glossaryTerms.length === 0) {
    throw new Error(`${GLOSSARY_MD} has no column for ${locale}`);
  }

  const selection = selectMessages({ entries, translations, glossaryTerms });

  const stamp = /POT-Creation-Date:\s*([^\\\n"]+)/.exec(sourceText);
  return buildPacket({
    locale,
    status,
    offered: picker.includes(locale),
    promotable: !layoutDeferred.includes(locale),
    catalogStamp: stamp ? stamp[1].trim() : 'an unrecorded date',
    messageCount: entries.length,
    glossaryTerms,
    neverTranslated: readSection(glossary, 'Never translated'),
    selection,
  });
}

export function parseArgs(argv) {
  let out = null;
  let locale = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[++i] ?? null;
    } else if (!argv[i].startsWith('--') && locale === null) {
      locale = argv[i];
    }
  }
  return { locale, out };
}

function main(argv) {
  const { locale, out } = parseArgs(argv);

  if (!locale) {
    console.error('Usage: node scripts/generate-locale-review-packet.mjs <locale> [--out <file>]');
    console.error('');
    console.error('  Builds the packet a native speaker reads to tell us whether a locale');
    console.error(`  reads correctly. Process: ${REVIEW_MD}`);
    return 1;
  }

  let packet;
  try {
    packet = generate({ locale });
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }

  if (out) {
    writeFileSync(out, packet);
    console.log(`Wrote the ${locale} review packet to ${out}`);
  } else {
    process.stdout.write(packet);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
