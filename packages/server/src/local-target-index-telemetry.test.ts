import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import { __resetIndexTelemetryForTests } from './index-telemetry.ts';
import { LocalTargetIndex } from './local-target-index.ts';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  __resetIndexTelemetryForTests();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await provider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
  __resetIndexTelemetryForTests();
});

function updateSpans(): ReadonlyArray<{ attributes: Record<string, unknown> }> {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.name === 'ok.index.update')
    .map((span) => ({ attributes: span.attributes as Record<string, unknown> }));
}

function createDiskRig(): {
  index: LocalTargetIndex;
  contentDir: string;
  write: (rel: string, body: string) => void;
} {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-lti-telemetry-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  const contentFilter = createContentFilter({ projectDir, contentDir });
  const index = new LocalTargetIndex({ contentDir, contentFilter });
  cleanups.push(() => {
    index.close();
    rmSync(projectDir, { recursive: true, force: true });
  });
  const write = (rel: string, body: string): void => {
    const filePath = join(contentDir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  };
  return { index, contentDir, write };
}

describe('local-target index update telemetry is proportional to real work', () => {
  test('an idle dependent-file sweep emits no ok.index.update spans', async () => {
    const rig = createDiskRig();
    rig.write('source.md', 'See [a](assets/a.pdf), [b](assets/b.pdf), [c](assets/c.pdf).\n');
    for (const name of ['a', 'b', 'c']) rig.write(`assets/${name}.pdf`, '%PDF-1.4\n');
    await rig.index.rebuildFromDisk({
      documentTargets: ['source'],
      fileTargets: ['assets/a.pdf', 'assets/b.pdf', 'assets/c.pdf'],
    });

    exporter.reset();
    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(0);
    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(0);

    expect(updateSpans()).toEqual([]);
  });

  test('a sweep that repairs a dropped watcher event still emits its span', async () => {
    const rig = createDiskRig();
    rig.write('source.md', 'Download [pdf](assets/report.pdf).\n');
    rig.write('assets/report.pdf', '%PDF-1.4\n');
    await rig.index.rebuildFromDisk({
      documentTargets: ['source'],
      fileTargets: ['assets/report.pdf'],
    });

    unlinkSync(join(rig.contentDir, 'assets/report.pdf'));
    exporter.reset();
    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(1);

    expect(updateSpans()).toEqual([
      {
        attributes: {
          'index.name': 'local-target',
          'index.mode': 'file-target',
          'index.occurrences': 1,
          'index.affected_sources': 1,
        },
      },
    ]);
  });

  test('a sweep repairing two dropped events emits one span per repaired target', async () => {
    const rig = createDiskRig();
    rig.write('source.md', 'See [a](assets/a.pdf) and [b](assets/b.pdf).\n');
    for (const name of ['a', 'b']) rig.write(`assets/${name}.pdf`, '%PDF-1.4\n');
    await rig.index.rebuildFromDisk({
      documentTargets: ['source'],
      fileTargets: ['assets/a.pdf', 'assets/b.pdf'],
    });

    unlinkSync(join(rig.contentDir, 'assets/a.pdf'));
    unlinkSync(join(rig.contentDir, 'assets/b.pdf'));
    exporter.reset();
    expect(await rig.index.reconcileDependentFileTargetsFromDisk()).toBe(2);

    expect(updateSpans()).toHaveLength(2);
  });

  test('setFileTarget spans the existence flip and nothing either side of it', () => {
    const index = new LocalTargetIndex({ contentDir: join(tmpdir(), 'ok-lti-telemetry-absent') });
    cleanups.push(() => index.close());
    index.setSource('source', 'Download [pdf](assets/report.pdf).\n');

    exporter.reset();
    expect(index.setFileTarget('assets/report.pdf', false)).toBe(0);
    expect(updateSpans()).toEqual([]);

    expect(index.setFileTarget('assets/report.pdf', true)).toBe(1);
    expect(updateSpans()).toHaveLength(1);

    exporter.reset();
    expect(index.setFileTarget('assets/report.pdf', true)).toBe(0);
    expect(updateSpans()).toEqual([]);
  });

  test('reconcileFileTargets spans a moved snapshot and not an identical one', () => {
    const index = new LocalTargetIndex({ contentDir: join(tmpdir(), 'ok-lti-telemetry-absent') });
    cleanups.push(() => index.close());
    index.setSource('source', 'Download [pdf](assets/report.pdf).\n');

    exporter.reset();
    expect(index.reconcileFileTargets(['assets/report.pdf'])).toBe(1);
    expect(updateSpans()).toHaveLength(1);

    exporter.reset();
    expect(index.reconcileFileTargets(['assets/report.pdf'])).toBe(0);
    expect(updateSpans()).toEqual([]);
  });
});
