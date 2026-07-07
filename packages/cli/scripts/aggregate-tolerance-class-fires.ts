#!/usr/bin/env bun
/**
 * Aggregate tolerance-class fire-rate data from the JSONL telemetry log
 * produced by OK_BRIDGE_TOLERANCE_TELEMETRY=1.
 *
 * Usage:
 *   bun run packages/cli/scripts/aggregate-tolerance-class-fires.ts <path-to-tolerance-telemetry.jsonl>
 *
 * Output: JSON to stdout with per-class, per-document, and per-severity breakdowns.
 */

import { readFileSync } from 'node:fs';

import type { ToleranceFireLine } from '@inkeep/open-knowledge-server';

// The line shape is owned by the writer (tolerance-telemetry-writer.ts) and
// imported here so a producer-side field rename fails this script's
// typecheck instead of silently desyncing the aggregation.
type FireRecord = ToleranceFireLine;

interface ClassStats {
  totalFires: number;
  uniqueDocuments: number;
  documents: Record<string, number>;
  severity: string;
  codeUnitPositions: { min: number; max: number; median: number };
}

function main(): void {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error(
      'Usage: bun run aggregate-tolerance-class-fires.ts <path-to-tolerance-telemetry.jsonl>',
    );
    process.exit(1);
  }

  const raw = readFileSync(logPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records: FireRecord[] = [];
  let skipped = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as FireRecord;
      if (parsed.event === 'bridge-tolerance-fire') {
        records.push(parsed);
      }
    } catch {
      // Torn/truncated lines are expected after sink rotation
      // (RotatingAppender ring); count rather than silently drop so a
      // corrupt log can't under-report totals without a signal.
      skipped += 1;
    }
  }

  if (skipped > 0) {
    console.error(`[aggregate-tolerance] skipped ${skipped} malformed line(s)`);
  }

  if (records.length === 0) {
    console.log(
      JSON.stringify(
        { totalRecords: 0, skippedLines: skipped, classes: {}, bySeverity: {} },
        null,
        2,
      ),
    );
    return;
  }

  const byClass = new Map<string, FireRecord[]>();
  const bySeverity = new Map<string, number>();

  for (const r of records) {
    const arr = byClass.get(r.class) ?? [];
    arr.push(r);
    byClass.set(r.class, arr);
    bySeverity.set(r.severity, (bySeverity.get(r.severity) ?? 0) + 1);
  }

  const classStats: Record<string, ClassStats> = {};
  for (const [cls, fires] of byClass) {
    const docCounts = new Map<string, number>();
    const positions: number[] = [];

    for (const f of fires) {
      const doc = f.document ?? '__unknown__';
      docCounts.set(doc, (docCounts.get(doc) ?? 0) + 1);
      if (f.codeUnitPosition >= 0) positions.push(f.codeUnitPosition);
    }

    positions.sort((a, b) => a - b);
    const median = positions.length > 0 ? (positions[Math.floor(positions.length / 2)] ?? -1) : -1;

    classStats[cls] = {
      totalFires: fires.length,
      uniqueDocuments: docCounts.size,
      documents: Object.fromEntries(docCounts),
      severity: fires[0]?.severity,
      codeUnitPositions: {
        min: positions.length > 0 ? (positions[0] ?? -1) : -1,
        max: positions.length > 0 ? (positions[positions.length - 1] ?? -1) : -1,
        median,
      },
    };
  }

  const timeRange =
    records.length > 0
      ? {
          earliest: records.reduce((a, b) => (a.timestamp < b.timestamp ? a : b)).timestamp,
          latest: records.reduce((a, b) => (a.timestamp > b.timestamp ? a : b)).timestamp,
        }
      : null;

  const report = {
    totalRecords: records.length,
    skippedLines: skipped,
    timeRange,
    bySeverity: Object.fromEntries(bySeverity),
    classes: classStats,
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
