
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  assertBridgeInvariant,
  createTestClient,
  createTestServer,
  pollUntil,
  serializeFragment,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('C10: server restart — canonical disk state converges on fresh server+client', () => {
  test('single-document canonical content loads into both XmlFragment and Y.Text with bridge invariant', async () => {
    const docName = `restart-single-${crypto.randomUUID()}`;
    const markerPre = 'C10-pre-restart-content-alpha';
    const canonical = `# Post-restart doc\n\n${markerPre}\n\nSecond paragraph with body text.\n`;

    writeFileSync(join(server.contentDir, `${docName}.md`), canonical, 'utf-8');
    await wait(300);

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => {
        const fragSerialized = serializeFragment(client.fragment);
        const ytextContent = client.ytext.toString();
        return fragSerialized.includes(markerPre) && ytextContent.includes(markerPre);
      }, 5000);

      assertBridgeInvariant(client.ytext, client.fragment);

      const fragSerialized = serializeFragment(client.fragment);
      const ytextContent = client.ytext.toString();
      const fragOccurrences = (fragSerialized.match(new RegExp(markerPre, 'g')) ?? []).length;
      const ytextOccurrences = (ytextContent.match(new RegExp(markerPre, 'g')) ?? []).length;

      expect(fragOccurrences).toBe(1);
      expect(ytextOccurrences).toBe(1);
    } finally {
      client.cleanup();
    }
  }, 30_000);

  test('multi-paragraph canonical content preserves order and all markers on load', async () => {
    const docName = `restart-multi-${crypto.randomUUID()}`;
    const marker1 = 'C10b-paragraph-one-alpha';
    const marker2 = 'C10b-paragraph-two-bravo';
    const marker3 = 'C10b-paragraph-three-charlie';
    const canonical = `# Multi-paragraph doc\n\n${marker1}\n\n${marker2}\n\n${marker3}\n`;

    writeFileSync(join(server.contentDir, `${docName}.md`), canonical, 'utf-8');
    await wait(300);

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => {
        const fragSerialized = serializeFragment(client.fragment);
        return (
          fragSerialized.includes(marker1) &&
          fragSerialized.includes(marker2) &&
          fragSerialized.includes(marker3)
        );
      }, 5000);

      assertBridgeInvariant(client.ytext, client.fragment);

      const fragSerialized = serializeFragment(client.fragment);
      const ytextContent = client.ytext.toString();

      expect(fragSerialized.indexOf(marker1)).toBeLessThan(fragSerialized.indexOf(marker2));
      expect(fragSerialized.indexOf(marker2)).toBeLessThan(fragSerialized.indexOf(marker3));
      expect(ytextContent.indexOf(marker1)).toBeLessThan(ytextContent.indexOf(marker2));
      expect(ytextContent.indexOf(marker2)).toBeLessThan(ytextContent.indexOf(marker3));

      for (const marker of [marker1, marker2, marker3]) {
        const fragCount = (fragSerialized.match(new RegExp(marker, 'g')) ?? []).length;
        const ytextCount = (ytextContent.match(new RegExp(marker, 'g')) ?? []).length;
        expect(fragCount).toBe(1);
        expect(ytextCount).toBe(1);
      }
    } finally {
      client.cleanup();
    }
  }, 30_000);

  test('client can edit after load — post-restart edits propagate through server observer', async () => {
    const docName = `restart-edit-${crypto.randomUUID()}`;
    const canonicalMarker = 'C10c-loaded-from-disk';
    const newMarker = 'C10c-added-after-reconnect';
    const canonical = `${canonicalMarker}\n`;

    writeFileSync(join(server.contentDir, `${docName}.md`), canonical, 'utf-8');
    await wait(300);

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes(canonicalMarker), 5000);

      const currentText = client.ytext.toString();
      client.doc.transact(() => {
        client.ytext.insert(currentText.length, `\n${newMarker}\n`);
      });

      await pollUntil(() => serializeFragment(client.fragment).includes(newMarker), 5000);

      assertBridgeInvariant(client.ytext, client.fragment);

      const fragSerialized = serializeFragment(client.fragment);
      const ytextContent = client.ytext.toString();

      expect(fragSerialized).toContain(canonicalMarker);
      expect(fragSerialized).toContain(newMarker);
      expect(ytextContent).toContain(canonicalMarker);
      expect(ytextContent).toContain(newMarker);

      const canonicalFragCount = (fragSerialized.match(new RegExp(canonicalMarker, 'g')) ?? [])
        .length;
      const newFragCount = (fragSerialized.match(new RegExp(newMarker, 'g')) ?? []).length;
      expect(canonicalFragCount).toBe(1);
      expect(newFragCount).toBe(1);
    } finally {
      client.cleanup();
    }
  }, 30_000);
});
