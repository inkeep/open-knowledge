import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE16_SLOTS, type Base16Scheme } from '@inkeep/open-knowledge-core';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { savedThemesDir, scanSavedThemes } from './saved-themes-store.ts';
import { __resetSavedThemesTelemetryForTests } from './saved-themes-telemetry.ts';
import { deleteSavedTheme, saveSavedTheme } from './saved-themes-write.ts';

const SAVE_METRIC = 'ok.saved_themes.save_total';
const DELETE_METRIC = 'ok.saved_themes.delete_total';
const SCAN_METRIC = 'ok.saved_themes.scan_total';
const PARSE_METRIC = 'ok.saved_themes.parse_total';
const PARSE_FAILURE_METRIC = 'ok.saved_themes.parse_failure_total';
const USABLE_COUNT_METRIC = 'ok.saved_themes.usable_count';

function scheme(): Base16Scheme {
  return {
    name: 'Private metric theme name',
    variant: 'dark',
    palette: Object.fromEntries(
      BASE16_SLOTS.map((slot, index) => {
        const byte = (index * 16).toString(16).padStart(2, '0');
        return [slot, `#${byte}${byte}${byte}`];
      }),
    ) as Base16Scheme['palette'],
  };
}

describe('saved-theme telemetry', () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let provider: MeterProvider;

  beforeAll(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    __resetSavedThemesTelemetryForTests();
  });

  afterAll(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetSavedThemesTelemetryForTests();
  });

  test('real save, delete, and parse-failure outcomes emit attribute-free counters', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-saved-theme-telemetry-'));
    try {
      const save = await saveSavedTheme({
        name: 'private-metric-filename',
        scheme: scheme(),
        homedirOverride: home,
      });
      expect(save.ok).toBe(true);

      const deletion = await deleteSavedTheme({
        id: 'saved-private-metric-filename',
        homedirOverride: home,
      });
      expect(deletion).toMatchObject({ ok: true, existed: true });

      const store = savedThemesDir(home);
      mkdirSync(store, { recursive: true });
      writeFileSync(
        join(store, 'private-parse-failure.yaml'),
        'name: "Private parse failure"\npalette:\n  base00: "#123456"\n',
      );
      expect(scanSavedThemes({ homedirOverride: home }).entries).toMatchObject([
        { ok: false, code: 'missing-slots' },
      ]);

      await reader.forceFlush();
      const points = exporter.getMetrics().flatMap((resourceMetrics) =>
        resourceMetrics.scopeMetrics.flatMap((scope) =>
          scope.metrics.flatMap((metric) =>
            metric.dataPoints.map((point) => ({
              name: metric.descriptor.name,
              attributes: point.attributes,
              value: point.value,
            })),
          ),
        ),
      );
      const savedThemePoints = points
        .filter(({ name }) =>
          [
            SAVE_METRIC,
            DELETE_METRIC,
            SCAN_METRIC,
            PARSE_METRIC,
            PARSE_FAILURE_METRIC,
            USABLE_COUNT_METRIC,
          ].includes(name),
        )
        .sort((a, b) => a.name.localeCompare(b.name));

      expect(savedThemePoints).toEqual([
        { name: DELETE_METRIC, attributes: {}, value: 1 },
        { name: PARSE_FAILURE_METRIC, attributes: {}, value: 1 },
        { name: PARSE_METRIC, attributes: {}, value: 2 },
        { name: SAVE_METRIC, attributes: {}, value: 1 },
        { name: SCAN_METRIC, attributes: {}, value: 1 },
        {
          name: USABLE_COUNT_METRIC,
          attributes: {},
          value: expect.objectContaining({ count: 1, sum: 0 }),
        },
      ]);
      expect(JSON.stringify(savedThemePoints)).not.toMatch(
        /private-metric-filename|Private metric theme name|private-parse-failure|#123456/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
