import type { Counter, Histogram } from '@opentelemetry/api';
import { getMeter } from './telemetry.ts';

export type TimelineQueryMode = 'doc' | 'folder';

export type WidthBucket = '0' | '1' | '2-5' | '6-20' | '21-50' | '50+';

export type CommitsBucket = '0' | '1-50' | '51-200' | '201-500' | '500+';

export function widthBucket(n: number): WidthBucket {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  if (n <= 50) return '21-50';
  return '50+';
}

export function commitsBucket(n: number): CommitsBucket {
  if (n <= 0) return '0';
  if (n <= 50) return '1-50';
  if (n <= 200) return '51-200';
  if (n <= 500) return '201-500';
  return '500+';
}

let _queryDuration: Histogram | null = null;
let _coalesced: Counter | null = null;

function queryDurationHist(): Histogram {
  _queryDuration ||= getMeter().createHistogram('ok.timeline.query_duration_ms', {
    description:
      'Wall-clock duration of one history query. Bounded labels: width_bucket (ref fan-out), commits_bucket (commits gathered), capped (depth bound hit), error (the walk threw — e.g. the PRD-6972 git timeout). The error label is what separates a timeout storm from a burst of legitimately-empty docs, both of which otherwise record width/commits 0.',
    unit: 'ms',
  });
  return _queryDuration;
}

function coalescedCounter(): Counter {
  _coalesced ||= getMeter().createCounter('ok.timeline.coalesced_total', {
    description:
      'History requests served by an in-flight single-flight walk instead of a fresh git walk. Bounded label: mode ∈ {doc, folder}. A high value is the poll-storm / fan-out signal.',
  });
  return _coalesced;
}

export function recordTimelineQuery(event: {
  durationMs: number;
  width: number;
  commits: number;
  capped: boolean;
  error?: boolean;
}): void {
  queryDurationHist().record(Math.max(0, event.durationMs), {
    width_bucket: widthBucket(event.width),
    commits_bucket: commitsBucket(event.commits),
    capped: event.capped,
    error: event.error ?? false,
  });
}

export function recordTimelineCoalesced(mode: TimelineQueryMode): void {
  coalescedCounter().add(1, { mode });
}

export function __resetTimelineTelemetryForTesting(): void {
  _queryDuration = null;
  _coalesced = null;
}
