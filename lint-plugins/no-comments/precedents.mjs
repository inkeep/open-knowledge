const SECTION_RE = /^##\s+/;
const HEADING_CLAIM_RE = /^##\s+.*\(precedents?\s+([^()]*)\)\s*$/;
const RANGE_RE = /^\s*(\d+)\s*[-–—]\s*(\d+)\s*$/;
const LEADING_NUMBER_RE = /^\s*(\d+)\b/;
const LIST_ENTRY_RE = /^(\d+)\.\s+\S/;
const RETRACTION_RE = /\bRETRACTED\b/;
const BOLD_LEAD_RE = /\*\*([\s\S]*?)\*\*/;

const PRECEDENT_CITATION_RE = /\bprecedent\s+#(\d+)/gi;

export const PRECEDENT_MANIFEST_VERSION = 1;

export class PrecedentManifestError extends Error {
  constructor(message, { source, key }) {
    super(`${source}${key ? ` (${key})` : ''}: ${message}`);
    this.name = 'PrecedentManifestError';
    this.source = source;
    this.key = key;
  }
}

export function diagnosePrecedentRegistry(load) {
  try {
    return { status: 'ok', registry: load() };
  } catch (error) {
    if (!(error instanceof PrecedentManifestError)) throw error;
    return {
      status: 'unreadable',
      source: error.source,
      key: error.key,
      message: `precedent-registry: UNREADABLE. ${error.message}`,
    };
  }
}

const ENTRY_FORMS = new Set(['list', 'heading']);

function claimedSlots(spec) {
  const slots = [];
  for (const part of spec.split(',')) {
    const range = RANGE_RE.exec(part);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n += 1) slots.push(n);
      continue;
    }
    const single = LEADING_NUMBER_RE.exec(part);
    if (single) slots.push(Number(single[1]));
  }
  return slots;
}

function readSections(markdown) {
  const sections = [];
  let section = null;
  markdown.split('\n').forEach((line, index) => {
    if (SECTION_RE.test(line)) {
      const claim = HEADING_CLAIM_RE.exec(line);
      section = {
        line: index + 1,
        heading: line,
        claims: claim ? claimedSlots(claim[1]) : [],
        items: [],
        body: [],
      };
      sections.push(section);
      return;
    }
    if (section === null) return;
    section.body.push(line);
    const item = LIST_ENTRY_RE.exec(line);
    if (item) section.items.push({ number: Number(item[1]), line: index + 1, text: line });
  });
  return sections;
}

export function readsAsRetracted(text) {
  return RETRACTION_RE.test(text);
}

function titleOf(text) {
  const bold = BOLD_LEAD_RE.exec(text);
  if (bold === null) return null;
  const title = bold[1].replace(/~~/g, '').replace(/\s+/g, ' ').trim();
  return title === '' ? null : title;
}

function readRegistry(markdown) {
  const sections = readSections(markdown);
  const claimed = new Set(sections.flatMap((section) => section.claims));
  const written = new Map();
  const problems = [];
  const outline = [];

  for (const section of sections) {
    const placed = [];
    const write = (number, definition) => {
      const already = written.get(number);
      if (already) {
        problems.push({
          kind: 'duplicate',
          number,
          detail: `precedent #${number} is written twice, at line ${already.line} and line ${definition.line}`,
        });
        return;
      }
      written.set(number, definition);
      placed.push({ number, ...definition });
    };

    for (const item of section.items) {
      write(item.number, { line: item.line, form: 'list', text: item.text });
    }
    const headingIsTheEntry =
      section.claims.length === 1 && section.items.length === 0 && section.body.join('').trim() !== '';
    if (headingIsTheEntry) {
      write(section.claims[0], {
        line: section.line,
        form: 'heading',
        text: section.body.join('\n'),
      });
    }
    outline.push({ heading: section.heading, placed });
  }

  for (const number of [...claimed].sort((a, b) => a - b)) {
    if (written.has(number)) continue;
    problems.push({
      kind: 'claimed-but-unwritten',
      number,
      detail: `a section heading claims precedent #${number}, but no entry writes it`,
    });
  }
  for (const [number, definition] of [...written].sort((a, b) => a[0] - b[0])) {
    if (claimed.has(number)) continue;
    problems.push({
      kind: 'unclaimed',
      number,
      detail: `precedent #${number} is written at line ${definition.line}, but no section heading claims it`,
    });
  }

  return { outline, written, problems };
}

export function parsePrecedentEntries(markdown) {
  const { written, problems } = readRegistry(markdown);
  const entries = [...written]
    .sort((a, b) => a[0] - b[0])
    .map(([number, definition]) => ({
      number,
      form: definition.form,
      retracted: readsAsRetracted(definition.text),
    }));

  return { entries, problems };
}

export function parsePrecedentOutline(markdown) {
  const { outline, problems } = readRegistry(markdown);
  const untitled = [];
  const sections = outline.map(({ heading, placed }) => ({
    heading,
    entries: placed.map((definition) => {
      const title = titleOf(definition.text);
      if (title === null) {
        untitled.push({
          kind: 'untitled',
          number: definition.number,
          detail:
            `precedent #${definition.number} at line ${definition.line} opens with no bold lead, ` +
            'so the public titles stub would have no title to show for it',
        });
      }
      return {
        number: definition.number,
        form: definition.form,
        retracted: readsAsRetracted(definition.text),
        title,
      };
    }),
  }));

  return { sections, problems: [...problems, ...untitled] };
}

function refuseUnsoundRegistry(problems, source) {
  if (problems.length === 0) return;
  throw new PrecedentManifestError(
    'not a sound precedent registry, so citations cannot be judged against it:\n' +
      `${problems.map((problem) => `  - ${problem.detail}`).join('\n')}\n` +
      'Repair the numbering rather than renumbering the entries; numbers are a citation contract.',
    { source },
  );
}

export function precedentEntriesFrom(markdown, source) {
  const { entries, problems } = parsePrecedentEntries(markdown);
  refuseUnsoundRegistry(problems, source);
  if (entries.length === 0) {
    throw new PrecedentManifestError(
      'parsed to zero precedent entries. Refusing to validate citations against an empty ' +
        'registry, which would classify every precedent #N citation as invalid and delete it. ' +
        'Check the file for conflict markers or reworded section headings.',
      { source },
    );
  }
  return entries;
}

export function precedentOutlineFrom(markdown, source) {
  const { sections, problems } = parsePrecedentOutline(markdown);
  refuseUnsoundRegistry(problems, source);
  if (sections.every((section) => section.entries.length === 0)) {
    throw new PrecedentManifestError(
      'parsed to zero precedent entries, so a titles index built from it would be empty. ' +
        'Check the file for conflict markers or reworded section headings.',
      { source },
    );
  }
  return sections;
}

export function buildPrecedentManifest(entries) {
  return { version: PRECEDENT_MANIFEST_VERSION, entries };
}

export function entriesFromManifest(manifest, source) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new PrecedentManifestError(
      'not a precedent manifest object. Regenerate it with `pnpm run generate:precedent-numbers`.',
      { source },
    );
  }
  if (manifest.version !== PRECEDENT_MANIFEST_VERSION) {
    throw new PrecedentManifestError(
      `declares precedent manifest version ${JSON.stringify(manifest.version)}, and this ` +
        `predicate reads version ${PRECEDENT_MANIFEST_VERSION}. Upgrade the predicate rather ` +
        'than validating citations against a schema it cannot read.',
      { source, key: 'version' },
    );
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new PrecedentManifestError(
      'carries no precedent entries. Regenerate it from PRECEDENTS.md.',
      { source, key: 'entries' },
    );
  }
  return manifest.entries.map((entry, index) => {
    const key = `entries[${index}]`;
    if (!Number.isInteger(entry?.number) || entry.number <= 0) {
      throw new PrecedentManifestError(
        `carries no positive integer number: ${JSON.stringify(entry)}.`,
        { source, key },
      );
    }
    if (!ENTRY_FORMS.has(entry.form)) {
      throw new PrecedentManifestError(
        `precedent #${entry.number} has form ${JSON.stringify(entry.form)}, which is not one of ` +
          `${[...ENTRY_FORMS].map((form) => JSON.stringify(form)).join(', ')}.`,
        { source, key },
      );
    }
    if (typeof entry.retracted !== 'boolean') {
      throw new PrecedentManifestError(
        `precedent #${entry.number} has no boolean retracted flag.`,
        { source, key },
      );
    }
    return { number: entry.number, form: entry.form, retracted: entry.retracted };
  });
}

export class PrecedentRegistry {
  #numbers;
  #retracted;

  constructor(entries = []) {
    this.#numbers = new Set(entries.map((entry) => entry.number));
    this.#retracted = new Set(
      entries.filter((entry) => entry.retracted).map((entry) => entry.number),
    );
  }

  has(number) {
    return this.#numbers.has(number);
  }

  isRetracted(number) {
    return this.#retracted.has(number);
  }

  get size() {
    return this.#numbers.size;
  }

  [Symbol.iterator]() {
    return this.#numbers[Symbol.iterator]();
  }
}

export class UnvalidatedPrecedentRegistry extends PrecedentRegistry {
  has() {
    return true;
  }

  isRetracted() {
    return false;
  }
}

export function citedPrecedentNumbers(commentText) {
  const cited = [];
  for (const match of commentText.matchAll(PRECEDENT_CITATION_RE)) cited.push(Number(match[1]));
  return cited;
}
