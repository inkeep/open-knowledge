import { describe, expect, test } from 'bun:test';
import { formatPackRationale, PACK_INSPIRATION_NOTE } from './rationale.ts';
import { STARTER_PACK_IDS, STARTER_PACKS } from './starter.ts';

describe('formatPackRationale', () => {
  test('headers with the pack name + description', () => {
    const out = formatPackRationale(STARTER_PACKS.worldbuilding);
    expect(out).toContain(STARTER_PACKS.worldbuilding.name);
    expect(out).toContain(STARTER_PACKS.worldbuilding.description);
  });

  test('surfaces every folder’s "why" + template names, for every pack', () => {
    for (const id of STARTER_PACK_IDS) {
      const pack = STARTER_PACKS[id];
      const out = formatPackRationale(pack);
      for (const folder of pack.folders) {
        expect(out).toContain(`${folder.path}/`);
        // the rationale ("why") is the authored folder description, verbatim
        expect(out).toContain(folder.description);
        expect(out).toContain(folder.starterTemplate);
        for (const extra of folder.extraTemplates ?? []) {
          expect(out).toContain(extra);
        }
      }
    }
  });

  test('carries the anti-clone inspiration note (adapt, not clone)', () => {
    expect(formatPackRationale(STARTER_PACKS['knowledge-base'])).toContain(PACK_INSPIRATION_NOTE);
    expect(PACK_INSPIRATION_NOTE.toLowerCase()).toContain('adapt');
    expect(PACK_INSPIRATION_NOTE).toContain('--dry-run');
  });

  test('lists root files when a pack ships them, omits the section otherwise', () => {
    // Derive expectations from the registry rather than hard-coding filenames,
    // so the test tracks the pack definition instead of drifting from it.
    const kbPack = STARTER_PACKS['knowledge-base'];
    const kbRootFiles = Object.keys(kbPack.rootFiles ?? {});
    expect(kbRootFiles.length).toBeGreaterThan(0); // guards the fixture choice below
    const kb = formatPackRationale(kbPack);
    expect(kb).toContain('Root files:');
    for (const fileName of kbRootFiles) {
      expect(kb).toContain(fileName);
    }
    // A pack with no rootFiles omits the section. Pick one from the registry
    // rather than assuming a specific pack stays root-file-free.
    const noRootFilesPack = STARTER_PACK_IDS.map((id) => STARTER_PACKS[id]).find(
      (p) => Object.keys(p.rootFiles ?? {}).length === 0,
    );
    expect(noRootFilesPack).toBeDefined();
    if (noRootFilesPack) {
      expect(formatPackRationale(noRootFilesPack)).not.toContain('Root files:');
    }
  });
});
