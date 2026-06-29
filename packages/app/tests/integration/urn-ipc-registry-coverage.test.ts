
import { describe, expect, test } from 'bun:test';
import { ProblemTypeSchema, URN_HTTP_ONLY, URN_IPC_REGISTRY } from '@inkeep/open-knowledge-core';

describe('URN → IPC registry coverage', () => {
  test('every URN in ProblemTypeSchema is either mapped to ≥1 channel or in URN_HTTP_ONLY', () => {
    const allUrns = ProblemTypeSchema.options;
    const mappedUrns = new Set<string>();
    for (const channelMap of Object.values(URN_IPC_REGISTRY)) {
      for (const urn of Object.keys(channelMap)) {
        mappedUrns.add(urn);
      }
    }
    const uncovered = allUrns.filter((urn) => !mappedUrns.has(urn) && !URN_HTTP_ONLY.has(urn));
    if (uncovered.length > 0) {
      const list = uncovered.map((u) => `  - ${u}`).join('\n');
      throw new Error(
        `URN(s) lack IPC mapping decision.\n` +
          `Adding a URN to ProblemTypeSchema requires an explicit decision: either\n` +
          `(a) add it to URN_IPC_REGISTRY[<channel>] with the IPC reason it maps to, OR\n` +
          `(b) add it to URN_HTTP_ONLY (the URN is HTTP-only by design).\n` +
          `Both files live at packages/core/src/handoff/urn-ipc-registry.ts.\n` +
          `Uncovered URNs:\n${list}`,
      );
    }
    expect(uncovered).toEqual([]);
  });

  test('no URN appears in both a channel map and URN_HTTP_ONLY (contradictory decisions)', () => {
    const mappedUrns = new Set<string>();
    for (const channelMap of Object.values(URN_IPC_REGISTRY)) {
      for (const urn of Object.keys(channelMap)) {
        mappedUrns.add(urn);
      }
    }
    const overlap = [...URN_HTTP_ONLY].filter((urn) => mappedUrns.has(urn));
    if (overlap.length > 0) {
      const list = overlap.map((u) => `  - ${u}`).join('\n');
      throw new Error(
        `URN(s) appear in BOTH URN_IPC_REGISTRY and URN_HTTP_ONLY — contradictory decisions.\n` +
          `A URN with a desktop IPC counterpart cannot also be HTTP-only. Pick one.\n` +
          `Conflicting URNs:\n${list}`,
      );
    }
    expect(overlap).toEqual([]);
  });
});
