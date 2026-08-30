import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { TRIAGED_SESSION_UPDATE_KINDS } from './thread-protocol.typelock.ts';

/**
 * The sibling typelock pins the session-update roster at compile time, which
 * only holds while that file is present and reachable by `tsc`. Deleting it,
 * or dropping it out of the typecheck include, would retire the tripwire in
 * silence. These read the same roster the SDK ships as data, so the alarm
 * survives independently of the type graph.
 */

/**
 * The JSON schema the SDK ships as a declared subpath export — the package's
 * own statement of the protocol it implements. What its generated runtime
 * validator does with a discriminator this roster omits is pinned separately,
 * by `packages/server/src/acp/typed-notice-canary.test.ts`.
 */
const SDK_SCHEMA_SPECIFIER = '@agentclientprotocol/sdk/schema/schema.json';

type SessionUpdateVariant = { properties?: { sessionUpdate?: { const?: unknown } } };
type ProtocolSchema = { $defs?: { SessionUpdate?: { oneOf?: SessionUpdateVariant[] } } };

/**
 * Throws rather than returning a short roster when the encoding moves. A
 * silently empty list would leave every check below passing while watching
 * nothing at all.
 */
function sessionUpdateKindsIn(schema: ProtocolSchema): string[] {
  const variants = schema.$defs?.SessionUpdate?.oneOf;
  if (variants === undefined) {
    throw new Error(
      `${SDK_SCHEMA_SPECIFIER} no longer exposes $defs.SessionUpdate.oneOf. The session-update roster moved; re-point this check before trusting it.`,
    );
  }
  return variants.map((variant, index) => {
    const kind = variant.properties?.sessionUpdate?.const;
    if (typeof kind !== 'string') {
      throw new Error(
        `SessionUpdate variant ${index} has no string sessionUpdate const. The discriminator encoding changed; re-point this check before trusting it.`,
      );
    }
    return kind;
  });
}

function loadSdkSchema(): ProtocolSchema {
  const path = createRequire(import.meta.url).resolve(SDK_SCHEMA_SPECIFIER);
  return JSON.parse(readFileSync(path, 'utf8')) as ProtocolSchema;
}

const declaredSessionUpdateKinds = (): string[] => sessionUpdateKindsIn(loadSdkSchema());

describe('installed SDK session-update roster', () => {
  test('declares exactly the discriminators that have been triaged', () => {
    expect([...declaredSessionUpdateKinds()].sort()).toEqual(
      [...TRIAGED_SESSION_UPDATE_KINDS].sort(),
    );
  });

  test('does not yet declare the typed notice discriminator', () => {
    const declared = declaredSessionUpdateKinds();

    // Naming a discriminator the SDK certainly has keeps the absence claim
    // from passing on an extraction that found nothing.
    expect(declared).toContain('agent_message_chunk');
    expect(declared).not.toContain('notice');
  });

  test('reports a notice discriminator once one is declared', () => {
    const grown = structuredClone(loadSdkSchema());
    grown.$defs?.SessionUpdate?.oneOf?.push({ properties: { sessionUpdate: { const: 'notice' } } });

    expect(sessionUpdateKindsIn(grown)).toContain('notice');
  });

  test('refuses a roster when the SessionUpdate variants have moved', () => {
    expect(() => sessionUpdateKindsIn({ $defs: {} })).toThrow(/re-point this check/);
  });

  test('refuses a roster when a variant carries no string discriminator', () => {
    const reshaped: ProtocolSchema = {
      $defs: { SessionUpdate: { oneOf: [{ properties: { sessionUpdate: {} } }] } },
    };

    expect(() => sessionUpdateKindsIn(reshaped)).toThrow(/discriminator encoding changed/);
  });
});
