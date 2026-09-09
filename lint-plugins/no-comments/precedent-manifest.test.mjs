import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { classifyComment } from './allowlist.mjs';
import { extractComments } from './extract.mjs';
import { loadPrecedentRegistry, readPrecedentManifest } from './index.mjs';
import {
  buildPrecedentManifest,
  PrecedentRegistry,
  precedentEntriesFrom,
  UnvalidatedPrecedentRegistry,
} from './precedents.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_SUBJECT_ROOT = join(MODULE_DIR, '..', '..');
const MANIFEST_PATH = join(MODULE_DIR, 'precedent-numbers.generated.json');
const entries = readPrecedentManifest();
const manifest = new PrecedentRegistry(entries);

function verdictFor(citation, precedentRegistry) {
  const [comment] = extractComments(citation);
  return classifyComment(comment, { precedentRegistry });
}

describe('precedent validation runs from the shipped numbers manifest alone', () => {
  test('the manifest is a non-empty set of positive slot numbers', () => {
    expect(manifest.size).toBeGreaterThan(0);
    for (const slot of manifest) {
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThan(0);
    }
  });

  test('the manifest carries the retraction the classifier needs, not only the numbers', () => {
    const retracted = entries.filter((entry) => entry.retracted).map((entry) => entry.number);
    expect(retracted).toStrictEqual([12, 29, 52]);
    for (const slot of retracted) expect(manifest.isRetracted(slot)).toBe(true);
  });

  test('it carries the one entry whose section heading is the entry', () => {
    expect(entries.filter((entry) => entry.form === 'heading').map((e) => e.number)).toStrictEqual([
      53,
    ]);
  });

  test('a real citation is admitted and a fabricated one is rejected', () => {
    const [real] = extractComments('// The alignment here follows precedent #42.');
    expect(classifyComment(real, { precedentRegistry: manifest }).allowed).toBe(true);

    const [fake] = extractComments('// Long design rationale, see precedent #999');
    const verdict = classifyComment(fake, { precedentRegistry: manifest });
    expect(verdict.allowed).toBe(false);
    expect(verdict.class).toBe('invalid-precedent');
  });

  test('a citation of a slot that kept its number but lost its rule is rejected too', () => {
    const [comment] = extractComments('// held here per precedent #52');
    const verdict = classifyComment(comment, { precedentRegistry: manifest });
    expect(verdict.allowed).toBe(false);
    expect(verdict.class).toBe('retracted-precedent');
    expect(verdict.detail).toContain('#52');
  });

  const precedentsPath = join(MODULE_DIR, '..', '..', 'PRECEDENTS.md');

  test.skipIf(!existsSync(precedentsPath))(
    'the manifest is regenerated whenever PRECEDENTS.md changes',
    () => {
      const live = precedentEntriesFrom(readFileSync(precedentsPath, 'utf8'), precedentsPath);

      expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(
        `${JSON.stringify(buildPrecedentManifest(live), null, 2)}\n`,
      );
    },
  );

  test('a caller that skips loading a registry fails loud instead of admitting citations', () => {
    const [comment] = extractComments('// as in precedent #7');
    expect(() => classifyComment(comment, {})).toThrow(/loadPrecedentRegistry/);
  });
});

describe('a repo root the shipped manifest does not describe', () => {
  const foreignRoot = mkdtempSync(join(tmpdir(), 'no-comments-foreign-root-'));
  const slotThisTreeIssued = Math.min(...manifest);
  const slotThisTreeNeverIssued = Math.max(...manifest) + 45;

  afterAll(() => {
    rmSync(foreignRoot, { recursive: true, force: true });
  });

  test('is a scratch tree with no PRECEDENTS.md, the shape the codemod --root flag is pointed at', () => {
    expect(existsSync(join(foreignRoot, 'PRECEDENTS.md'))).toBe(false);
    expect(foreignRoot).not.toBe(MANIFEST_SUBJECT_ROOT);
    expect(manifest.has(slotThisTreeIssued)).toBe(true);
    expect(manifest.has(slotThisTreeNeverIssued)).toBe(false);
  });

  test('loads a registry that validates nothing rather than borrowing this tree numbers', () => {
    const registry = loadPrecedentRegistry(foreignRoot);
    expect(registry).toBeInstanceOf(UnvalidatedPrecedentRegistry);
    expect([...registry]).toStrictEqual([]);
  });

  test('says so rather than degrading in silence, naming the root and the missing file', () => {
    const announced = [];
    const uncachedRoot = mkdtempSync(join(tmpdir(), 'no-comments-foreign-root-'));
    try {
      loadPrecedentRegistry(uncachedRoot, { notify: (line) => announced.push(line) });
    } finally {
      rmSync(uncachedRoot, { recursive: true, force: true });
    }

    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain(uncachedRoot);
    expect(announced[0]).toContain('PRECEDENTS.md');
  });

  test('says so once, not once per lane: the absent file is a cached state, not a miss', () => {
    const announced = [];
    const uncachedRoot = mkdtempSync(join(tmpdir(), 'no-comments-foreign-root-'));
    try {
      const first = loadPrecedentRegistry(uncachedRoot, { notify: (line) => announced.push(line) });
      const second = loadPrecedentRegistry(uncachedRoot, {
        notify: (line) => announced.push(line),
      });
      expect(second).toBe(first);
    } finally {
      rmSync(uncachedRoot, { recursive: true, force: true });
    }

    expect(announced).toHaveLength(1);
  });

  test('admits a retracted slot there too, because retraction is this tree ruling', () => {
    const verdict = verdictFor('// per precedent #52', loadPrecedentRegistry(foreignRoot));
    expect(verdict.allowed).toBe(true);
    expect(verdict.class).toBe('precedent-citation');
  });

  test('admits a citation this tree never issued instead of marking it invalid for deletion', () => {
    const verdict = verdictFor(
      `// per precedent #${slotThisTreeNeverIssued}`,
      loadPrecedentRegistry(foreignRoot),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.class).toBe('precedent-citation');
  });

  test('reaches that verdict for every citation, so no verdict turns on this tree numbering', () => {
    const registry = loadPrecedentRegistry(foreignRoot);
    const shape = (slot) => {
      const verdict = verdictFor(`// per precedent #${slot}`, registry);
      return { allowed: verdict.allowed, class: verdict.class };
    };

    expect(shape(slotThisTreeNeverIssued)).toStrictEqual(shape(slotThisTreeIssued));
  });

  test('the root the manifest does describe still rejects a fabricated citation', () => {
    const registry = loadPrecedentRegistry(MANIFEST_SUBJECT_ROOT);
    expect(registry).not.toBeInstanceOf(UnvalidatedPrecedentRegistry);

    const verdict = verdictFor(`// per precedent #${slotThisTreeNeverIssued}`, registry);
    expect(verdict.allowed).toBe(false);
    expect(verdict.class).toBe('invalid-precedent');
  });
});

describe('the tree the manifest describes is read from the manifest, not from the markdown', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'no-comments-manifest-first-'));
  const slotOnlyTheMarkdownKnows = 991;

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test('a citation only PRECEDENTS.md backs is rejected, so the markdown is never opened', async () => {
    cpSync(join(MODULE_DIR, '..'), join(scratch, 'lint-plugins'), { recursive: true });
    writeFileSync(
      join(scratch, 'PRECEDENTS.md'),
      `## Scratch (precedent ${slotOnlyTheMarkdownKnows})\n\n${slotOnlyTheMarkdownKnows}. **A slot the shipped manifest never carried.** Body.\n`,
    );
    const scratchIndex = await import(
      pathToFileURL(join(scratch, 'lint-plugins/no-comments/index.mjs')).href
    );

    const registry = scratchIndex.loadPrecedentRegistry(scratch);
    expect(registry.has(slotOnlyTheMarkdownKnows)).toBe(false);
    expect(registry.size).toBe(entries.length);

    const [comment] = scratchIndex.extractComments(`// per precedent #${slotOnlyTheMarkdownKnows}`);
    expect(scratchIndex.classifyComment(comment, { precedentRegistry: registry }).class).toBe(
      'invalid-precedent',
    );
  });
});

describe('a long-lived host reads PRECEDENTS.md as it is now, not as it was at first load', () => {
  const root = mkdtempSync(join(tmpdir(), 'no-comments-precedents-mtime-'));
  const precedentsPath = join(root, 'PRECEDENTS.md');
  const slotWrittenFirst = 992;
  const slotAddedLater = 993;
  const PINNED_EPOCH_SECONDS = 1_700_000_000;

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const registrySource = (slots) =>
    `## Scratch (precedents ${slots.join(', ')})\n\n${slots
      .map((slot) => `${slot}. **Slot ${slot}.** Body.\n`)
      .join('')}`;

  let pinsIssued = 0;
  const pinDistinctMtime = (path) => {
    pinsIssued += 1;
    const seconds = PINNED_EPOCH_SECONDS + pinsIssued;
    utimesSync(path, seconds, seconds);
  };

  const writeRegistry = (slots) => {
    writeFileSync(precedentsPath, registrySource(slots));
    pinDistinctMtime(precedentsPath);
  };

  test('a slot added between two calls in one process is admitted by the second', () => {
    writeRegistry([slotWrittenFirst]);
    const first = loadPrecedentRegistry(root);
    expect(first.has(slotWrittenFirst)).toBe(true);
    expect(first.has(slotAddedLater)).toBe(false);

    writeRegistry([slotWrittenFirst, slotAddedLater]);

    const second = loadPrecedentRegistry(root);
    expect(second.has(slotAddedLater)).toBe(true);
    expect(verdictFor(`// per precedent #${slotAddedLater}`, second).class).toBe(
      'precedent-citation',
    );
  });

  test('an unedited registry keeps serving the parse it already paid for', () => {
    expect(loadPrecedentRegistry(root)).toBe(loadPrecedentRegistry(root));
  });

  test('a PRECEDENTS.md that appears after an unvalidated load starts validating', () => {
    const bare = mkdtempSync(join(tmpdir(), 'no-comments-precedents-late-'));
    try {
      expect(loadPrecedentRegistry(bare, { notify: () => {} })).toBeInstanceOf(
        UnvalidatedPrecedentRegistry,
      );

      writeFileSync(
        join(bare, 'PRECEDENTS.md'),
        `## Scratch (precedent ${slotWrittenFirst})\n\n${slotWrittenFirst}. **Slot ${slotWrittenFirst}.** Body.\n`,
      );

      const registry = loadPrecedentRegistry(bare, { notify: () => {} });
      expect(registry).not.toBeInstanceOf(UnvalidatedPrecedentRegistry);
      expect(registry.has(slotWrittenFirst)).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('a slot added by a write that leaves the mtime unchanged is admitted by the second call', () => {
    const collidingRoot = mkdtempSync(join(tmpdir(), 'no-comments-precedents-same-mtime-'));
    const collidingPath = join(collidingRoot, 'PRECEDENTS.md');
    const writeAtOneInstant = (slots) => {
      writeFileSync(collidingPath, registrySource(slots));
      utimesSync(collidingPath, PINNED_EPOCH_SECONDS, PINNED_EPOCH_SECONDS);
    };

    try {
      writeAtOneInstant([slotWrittenFirst]);
      const mtimeAtFirstLoad = statSync(collidingPath).mtimeMs;
      const first = loadPrecedentRegistry(collidingRoot);
      expect(first.has(slotWrittenFirst)).toBe(true);
      expect(first.has(slotAddedLater)).toBe(false);

      writeAtOneInstant([slotWrittenFirst, slotAddedLater]);
      expect(statSync(collidingPath).mtimeMs).toBe(mtimeAtFirstLoad);
      expect(readFileSync(collidingPath, 'utf8')).toContain(`${slotAddedLater}. **Slot`);

      const second = loadPrecedentRegistry(collidingRoot);
      expect(second.has(slotAddedLater)).toBe(true);
      expect(verdictFor(`// per precedent #${slotAddedLater}`, second).class).toBe(
        'precedent-citation',
      );
    } finally {
      rmSync(collidingRoot, { recursive: true, force: true });
    }
  });
});
