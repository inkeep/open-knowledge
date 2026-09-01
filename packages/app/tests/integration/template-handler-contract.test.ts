import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  HANDLER_RUN_END_NEEDLES,
  listNativeRouteFiles,
} from '../native-route-files.test-helper.ts';

const SERVER_SRC = join(import.meta.dirname, '../../../server/src');
const SOURCES = ['api-extension.ts', ...listNativeRouteFiles(SERVER_SRC)].map((rel) =>
  readFileSync(join(SERVER_SRC, rel), 'utf8'),
);

function extractHandlerBody(handlerName: string): string {
  const source = SOURCES.find((s) => s.includes(`const ${handlerName} = withValidation(`));
  if (!source) throw new Error(`${handlerName}: withValidation handler not found in source`);
  const start = source.indexOf(`const ${handlerName} = withValidation(`);
  const candidates = [
    '\n  async function handle',
    '\n  const handle',
    ...HANDLER_RUN_END_NEEDLES,
    '\n  return {',
  ]
    .map((needle) => source.indexOf(needle, start + 1))
    .filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return source.slice(start, next === -1 ? source.length : next);
}

const put = extractHandlerBody('handleTemplatePut');
const del = extractHandlerBody('handleTemplateDelete');
const move = extractHandlerBody('handleTemplateMove');
const imp = extractHandlerBody('handleTemplateImport');

describe('template handler asymmetries (FR5)', () => {
  test('move gates the FROM side only — exactly one conflict gate, keyed on fromName', () => {
    const gateCalls = move.match(/checkTemplateConflictGate\(/g) ?? [];
    expect(gateCalls.length).toBe(1);
    expect(
      /checkTemplateConflictGate\(\s*templateDocNameFor\(fromValidated\.folderRel, body\.fromName\)/.test(
        move,
      ),
    ).toBe(true);
    expect(/checkTemplateConflictGate\(\s*templateDocNameFor\(toValidated/.test(move)).toBe(false);
  });

  test("move's optional content-edit tail is fs-direct AFTER the source-doc teardown", () => {
    const teardown = move.indexOf('captureAndCloseDocuments(');
    const fsDirectEdit = move.indexOf('applyTemplateWrite(');
    expect(teardown).toBeGreaterThan(-1);
    expect(fsDirectEdit).toBeGreaterThan(-1);
    expect(teardown).toBeLessThan(fsDirectEdit);
  });

  test('the files signal fires on move and import but not on put and delete', () => {
    expect(move.includes("signalChannel?.('files')")).toBe(true);
    expect(imp.includes("signalChannel?.('files')")).toBe(true);
    expect(put.includes("signalChannel?.('files')")).toBe(false);
    expect(del.includes("signalChannel?.('files')")).toBe(false);
  });
});
