import { describe, expect, test } from 'vitest';
import { AGENT_REGISTRY } from './agents.ts';
import { CAPABILITY_RECORDS } from './capabilities.ts';
import {
  GUIDANCE_IDS,
  GUIDANCE_KEYS,
  GUIDANCE_NAMESPACES,
  getGuidanceEntry,
  guidanceNamespaceOf,
  guidanceParamNames,
  isGuidanceKey,
} from './guidance.ts';
import type { GuidanceRef } from './schema.ts';
import { CONSENT_CLASSES } from './vocabulary.ts';

function allGuidanceRefs(): { site: string; ref: GuidanceRef }[] {
  const found: { site: string; ref: GuidanceRef }[] = [];
  for (const agent of Object.values(AGENT_REGISTRY)) {
    for (const satisfier of agent.satisfiers) {
      for (const slot of ['guidance', 'followup', 'troubleshooting'] as const) {
        const ref = satisfier[slot];
        if (ref) found.push({ site: `${satisfier.id}#${slot}`, ref });
      }
    }
    for (const [mode, record] of Object.entries(agent.modes)) {
      for (const ref of record.caveats) found.push({ site: `${agent.id}/${mode}#caveat`, ref });
    }
  }
  for (const capability of CAPABILITY_RECORDS) {
    if (capability.guidance)
      found.push({ site: `capability:${capability.id}`, ref: capability.guidance });
  }
  return found;
}

describe('the guidance manifest', () => {
  test('is not empty', () => {
    expect(GUIDANCE_KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(GUIDANCE_IDS)).toHaveLength(GUIDANCE_KEYS.length);
  });

  test('gives every key a parameter schema', () => {
    for (const key of GUIDANCE_KEYS) {
      const entry = GUIDANCE_IDS[key];
      expect(entry, key).toBeDefined();
      expect(typeof entry.params.shape, key).toBe('object');
      expect(getGuidanceEntry(key), key).toBe(entry);
    }
  });

  test('puts every key in one of the three tiers', () => {
    for (const key of GUIDANCE_KEYS) {
      expect(guidanceNamespaceOf(key), key).not.toBeNull();
    }
    expect(guidanceNamespaceOf('nope.something')).toBeNull();
    expect(guidanceNamespaceOf('')).toBeNull();
  });

  test('carries a follow-up key for exactly the consent classes that owe the user a step', () => {
    const owed = CONSENT_CLASSES.filter((consentClass) => consentClass !== 'none');
    const declared = GUIDANCE_KEYS.filter((key) => guidanceNamespaceOf(key) === 'followup');
    expect([...declared].sort()).toEqual(
      owed.map((consentClass) => `followup.${consentClass}`).sort(),
    );
  });

  test('names its parameters in sorted order for a stable comparison', () => {
    expect(guidanceParamNames('troubleshooting.copilot.shared-workspace-config')).toEqual([
      'agent',
      'sourceAgent',
    ]);
    expect(guidanceParamNames('guidance.skill.project')).toEqual(['agent']);
  });

  test('rejects a key it does not carry', () => {
    expect(isGuidanceKey('guidance.mcp.user-config')).toBe(true);
    expect(isGuidanceKey('guidance.mcp.made-up')).toBe(false);
    expect(getGuidanceEntry('guidance.mcp.made-up')).toBeUndefined();
  });
});

describe('registry references into the manifest', () => {
  test('there is at least one to check', () => {
    expect(allGuidanceRefs().length).toBeGreaterThan(0);
  });

  test('every reference resolves to a manifest key', () => {
    const unresolved = allGuidanceRefs()
      .filter(({ ref }) => !isGuidanceKey(ref.id))
      .map(({ site, ref }) => `${site} -> ${ref.id}`);
    expect(unresolved).toEqual([]);
  });

  test('every reference supplies exactly the parameters its key declares', () => {
    const mismatched: string[] = [];
    for (const { site, ref } of allGuidanceRefs()) {
      const entry = getGuidanceEntry(ref.id);
      if (!entry) continue;
      const parsed = entry.params.safeParse(ref.params ?? {});
      if (!parsed.success) mismatched.push(`${site} -> ${ref.id}: ${parsed.error.message}`);
    }
    expect(mismatched).toEqual([]);
  });

  test('no manifest key goes unreferenced', () => {
    const referenced = new Set(allGuidanceRefs().map(({ ref }) => String(ref.id)));
    const orphans = GUIDANCE_KEYS.filter((key) => !referenced.has(key));
    expect(orphans).toEqual([]);
  });
});

describe('parameter validation bites', () => {
  const entry = GUIDANCE_IDS['troubleshooting.codex.desktop-project-config'];

  test('accepts the shape the registry supplies', () => {
    expect(entry.params.safeParse({ agent: 'codex', honoredByDesktop: false }).success).toBe(true);
  });

  test('rejects an undeclared parameter rather than dropping it', () => {
    const parsed = entry.params.safeParse({
      agent: 'codex',
      honoredByDesktop: false,
      extra: 'nope',
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects a missing parameter', () => {
    expect(entry.params.safeParse({ agent: 'codex' }).success).toBe(false);
  });

  test('rejects a parameter of the wrong type', () => {
    expect(entry.params.safeParse({ agent: 'codex', honoredByDesktop: 'false' }).success).toBe(
      false,
    );
  });

  test('rejects an agent that is not one of ours', () => {
    expect(
      GUIDANCE_IDS['guidance.skill.project'].params.safeParse({ agent: 'notepad' }).success,
    ).toBe(false);
  });
});

describe('namespaces', () => {
  test('are the prefixes the manifest actually uses', () => {
    const used = new Set(GUIDANCE_KEYS.map((key) => guidanceNamespaceOf(key)));
    expect([...GUIDANCE_NAMESPACES].sort()).toEqual([...used].sort());
  });
});
