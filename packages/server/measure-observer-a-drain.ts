import { arch, cpus, platform } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { loadLargeRealistic } from '../core/src/markdown/fixtures/index.ts';
import { composeAndWriteRawBody } from './src/bridge-intake.ts';
import { mdManager } from './src/md-manager.ts';
import { setupServerObservers } from './src/server-observers.ts';

export type CaretPosition = 'start' | 'middle' | 'end';

export interface DrainMeasurementArgs {
  readonly carets: CaretPosition[];
  readonly fixtureMultiple: number;
  readonly keystrokes: number;
}

export interface DrainMeasurement {
  readonly caret: CaretPosition;
  readonly capturedAt: string;
  readonly host: { readonly platform: string; readonly arch: string; readonly cpus: number };
  readonly nodeVersion: string;
  readonly bodyBytes: number;
  readonly keystrokes: number;
  readonly totalMs: number;
  readonly perKeystrokeMedianMs: number;
  readonly perKeystrokeMaxMs: number;
  readonly serializeCallsPerDrain: number;
  readonly parseCallsPerDrain: number;
  readonly markerLanded: boolean;
}

const RESULT_PREFIX = 'OBSERVER_A_DRAIN_RESULT ';
const ALL_CARETS: CaretPosition[] = ['start', 'middle', 'end'];

export function parseDrainMeasurementArgs(argv: readonly string[]): DrainMeasurementArgs {
  let carets = ALL_CARETS;
  let fixtureMultiple = 3;
  let keystrokes = 15;
  const positiveInteger = (flag: string, raw: string): number => {
    if (!/^[0-9]+$/.test(raw)) throw new Error(`${flag} must be a positive integer, got ${raw}`);
    const parsed = Number(raw);
    if (parsed < 1) throw new Error(`${flag} must be a positive integer, got ${raw}`);
    return parsed;
  };
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < normalized.length; i++) {
    const flag = normalized[i];
    if (flag !== '--caret' && flag !== '--fixture-multiple' && flag !== '--keystrokes') {
      throw new Error(`unknown flag ${flag}; use --caret, --fixture-multiple or --keystrokes`);
    }
    const value = normalized[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--caret') {
      const requested = value.split(',');
      const unknown = requested.filter((c) => !ALL_CARETS.includes(c as CaretPosition));
      if (unknown.length > 0) {
        throw new Error(`--caret does not accept ${unknown.join(',')}; use start, middle or end`);
      }
      carets = requested as CaretPosition[];
    } else if (flag === '--fixture-multiple') {
      fixtureMultiple = positiveInteger(flag, value);
    } else if (flag === '--keystrokes') {
      keystrokes = positiveInteger(flag, value);
    } else {
      const unreachable: never = flag;
      throw new Error(`unknown flag ${String(unreachable)}`);
    }
    i++;
  }
  return { carets, fixtureMultiple, keystrokes };
}

function collectTextNodes(
  node: Y.XmlFragment | Y.XmlElement,
  found: Y.XmlText[] = [],
): Y.XmlText[] {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText) found.push(child);
    else if (child instanceof Y.XmlElement) collectTextNodes(child, found);
  }
  return found;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1));
}

export function measureDrain(caret: CaretPosition, args: DrainMeasurementArgs): DrainMeasurement {
  const base = loadLargeRealistic();
  const raw = Array.from({ length: args.fixtureMultiple }, () => base).join('\n');
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');

  doc.transact(() => {
    composeAndWriteRawBody(doc, raw, 'agent');
  });
  const cleanup = setupServerObservers({
    doc,
    xmlFragment,
    ytext,
    mdManager,
    schema: getSchema(sharedExtensions),
    docName: 'measure-observer-a-drain',
  });

  const texts = collectTextNodes(xmlFragment);
  const target =
    caret === 'start'
      ? texts[0]
      : caret === 'middle'
        ? texts[Math.floor(texts.length / 2)]
        : texts[texts.length - 1];
  if (!target) throw new Error('fixture produced no editable text node');

  const originalSerialize = mdManager.serialize.bind(mdManager);
  const originalParse = mdManager.parseToEditorMdast.bind(mdManager);
  let serializeCalls = 0;
  let parseCalls = 0;
  mdManager.serialize = (json, opts) => {
    serializeCalls++;
    return originalSerialize(json, opts);
  };
  mdManager.parseToEditorMdast = (markdown) => {
    parseCalls++;
    return originalParse(markdown);
  };

  const marker = 'MEASURE'.repeat(Math.ceil(args.keystrokes / 7)).slice(0, args.keystrokes);
  const perKeystroke: number[] = [];
  try {
    const startedAt = performance.now();
    for (const char of marker) {
      const at = performance.now();
      doc.transact(() => {
        target.insert(target.length, char);
      });
      perKeystroke.push(performance.now() - at);
    }
    const totalMs = performance.now() - startedAt;
    return {
      caret,
      capturedAt: new Date().toISOString(),
      host: { platform: platform(), arch: arch(), cpus: cpus().length },
      nodeVersion: process.version,
      bodyBytes: raw.length,
      keystrokes: marker.length,
      totalMs: Number(totalMs.toFixed(1)),
      perKeystrokeMedianMs: median(perKeystroke),
      perKeystrokeMaxMs: Number(Math.max(...perKeystroke).toFixed(1)),
      serializeCallsPerDrain: Number((serializeCalls / marker.length).toFixed(2)),
      parseCallsPerDrain: Number((parseCalls / marker.length).toFixed(2)),
      markerLanded: ytext.toString().includes(marker),
    };
  } finally {
    mdManager.serialize = originalSerialize;
    mdManager.parseToEditorMdast = originalParse;
    cleanup?.();
  }
}

function runCampaign(args: DrainMeasurementArgs): void {
  for (const caret of args.carets) {
    const measurement = measureDrain(caret, args);
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(measurement)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCampaign(parseDrainMeasurementArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
