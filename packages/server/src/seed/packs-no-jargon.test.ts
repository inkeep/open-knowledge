import { describe, expect, test } from 'vitest';
import { STARTER_PACK_IDS, STARTER_PACKS } from './starter.ts';

function userFacingStrings(): string[] {
  const out: string[] = [];
  for (const id of STARTER_PACK_IDS) {
    const pack = STARTER_PACKS[id];
    out.push(pack.name, pack.description);
    for (const folder of pack.folders) {
      out.push(folder.title, folder.description);
      if (folder.uiSummary) out.push(folder.uiSummary);
    }
    out.push(...Object.values(pack.templates));
    if (pack.rootFiles) out.push(...Object.values(pack.rootFiles));
  }
  return out;
}

describe('starter packs — no insider jargon in user-facing copy', () => {
  test('no "sweep" in any folder description, template body, or root file', () => {
    const offenders = userFacingStrings().filter((s) => /\bsweeps?\b/i.test(s));
    expect(offenders).toEqual([]);
  });
});

describe('starter packs — every folder ships a user-facing uiSummary', () => {
  test('every folder has a non-empty uiSummary', () => {
    const missing: string[] = [];
    for (const id of STARTER_PACK_IDS) {
      for (const folder of STARTER_PACKS[id].folders) {
        if (!folder.uiSummary || folder.uiSummary.trim() === '') {
          missing.push(`${id}/${folder.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every uiSummary is short and free of code spans', () => {
    const offenders: string[] = [];
    for (const id of STARTER_PACK_IDS) {
      for (const folder of STARTER_PACKS[id].folders) {
        const s = folder.uiSummary ?? '';
        if (s.includes('`') || s.length > 80) offenders.push(`${id}/${folder.path}: "${s}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
