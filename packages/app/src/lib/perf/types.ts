type DevToolsColor =
  | 'primary'
  | 'primary-light'
  | 'primary-dark'
  | 'secondary'
  | 'secondary-light'
  | 'secondary-dark'
  | 'tertiary'
  | 'tertiary-light'
  | 'tertiary-dark'
  | 'error';

export interface DevToolsTrackEntry {
  dataType: 'track-entry';
  track: string;
  trackGroup?: string;
  color?: DevToolsColor;
  properties?: Array<[string, string]>;
  tooltipText?: string;
}

export interface PerfMarkDetail {
  devtools: DevToolsTrackEntry;
}

export interface PerfMark {
  name: string;
  startTime: number;
  duration: number;
  track: string;
  properties?: Record<string, unknown>;
}

type ProfilerPhase = 'mount' | 'update' | 'nested-update';

export interface ProfilerRenderEvent {
  id: string;
  phase: ProfilerPhase;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

export type WebVitalName = 'INP' | 'LCP' | 'CLS' | 'FCP' | 'TTFB';

export interface WebVitalsMark {
  name: WebVitalName;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta: number;
  id: string;
  navigationType?: string;
  attribution?: Record<string, unknown>;
}

import type { CircularBuffer } from './circular-buffer';
import type { Histogram } from './hdr-histogram';

export interface PerfCounter {
  total: number;
  byProp: Record<string, Record<string, number>>;
}

export type { HistogramSnapshot } from './hdr-histogram';

export interface PerfCollector {
  marks: CircularBuffer<PerfMark>;
  vitals: CircularBuffer<WebVitalsMark>;
  counters: Record<string, PerfCounter>;
  histograms: Record<string, Histogram>;
  startedAt: number;
  reset(): void;
}
