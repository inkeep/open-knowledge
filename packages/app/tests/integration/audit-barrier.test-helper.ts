import * as core from '@inkeep/open-knowledge-core';
import { vi } from 'vitest';
import { pollUntil } from './test-harness.ts';

const BARRIER_ARRIVAL_TIMEOUT_MS = 20_000;

export interface AuditBarrier {
  waitUntilStarted(timeoutMs?: number): Promise<void>;
  release(): void;
  dispose(): void;
  observedDocuments(): readonly string[];
}

export function pauseAuditAtDocument(docRelPath: string): AuditBarrier {
  if (vi.isMockFunction(core.lintDocument)) {
    throw new Error(
      `pauseAuditAtDocument(${docRelPath}): core.lintDocument is already mocked. ` +
        'Only one barrier may be live at a time; dispose the previous one first.',
    );
  }
  let arrived = false;
  const observed: string[] = [];
  const resume = Promise.withResolvers<void>();
  const lintDocument = core.lintDocument;
  const spy = vi
    .spyOn(core, 'lintDocument')
    .mockImplementation(async (text, config, docName, ...rest) => {
      if (docName !== undefined) observed.push(docName);
      if (docName === docRelPath) {
        arrived = true;
        await resume.promise;
      }
      return lintDocument(text, config, docName, ...rest);
    });
  return {
    waitUntilStarted(timeoutMs = BARRIER_ARRIVAL_TIMEOUT_MS) {
      return pollUntil(
        () => arrived,
        timeoutMs,
        10,
        `the server-side audit walk to enter lintDocument for ${docRelPath}`,
      );
    },
    release() {
      if (!arrived) {
        throw new Error(
          `release() before the server-side audit walk entered lintDocument for ${docRelPath}`,
        );
      }
      resume.resolve();
    },
    dispose() {
      resume.resolve();
      spy.mockRestore();
    },
    observedDocuments() {
      return [...observed];
    },
  };
}
