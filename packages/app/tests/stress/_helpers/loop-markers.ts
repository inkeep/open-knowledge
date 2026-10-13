import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PACKAGE_ROOT } from './seed-key.ts';

export const LOOP_MARKER_SOURCES = {
  app: 'packages/app/src/test-utils/test-loop-marker.ts',
  server: 'packages/server/src/test-loop-marker.ts',
  core: 'packages/core/src/test-loop-marker.ts',
} as const;

export type LoopMarkerClass = keyof typeof LOOP_MARKER_SOURCES;

export const EXPECTED_LOOP_MARKERS_ENV = 'OK_TEST_LOOP_EXPECTED_MARKERS';

const OK_ROOT = join(APP_PACKAGE_ROOT, '..', '..');
const MARKER_SOURCE = /^export const [A-Z_]+ = '([a-z0-9-]+)';\n$/;

function markerOnDisk(markerClass: LoopMarkerClass): string {
  const path = LOOP_MARKER_SOURCES[markerClass];
  const match = MARKER_SOURCE.exec(readFileSync(join(OK_ROOT, path), 'utf8'));
  if (match === null) throw new Error(`${path} is not a single exported marker literal`);
  return match[1];
}

function instrumentExpectation(markerClass: LoopMarkerClass): string | undefined {
  const raw = process.env[EXPECTED_LOOP_MARKERS_ENV];
  if (raw === undefined || raw === '') return undefined;
  const parsed: unknown = JSON.parse(raw);
  const value =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[markerClass]
      : undefined;
  if (typeof value !== 'string') {
    throw new Error(`${EXPECTED_LOOP_MARKERS_ENV} names no ${markerClass} marker: ${raw}`);
  }
  return value;
}

export function expectedLoopMarker(markerClass: LoopMarkerClass): {
  readonly onDisk: string;
  readonly instrument: string | undefined;
} {
  return { onDisk: markerOnDisk(markerClass), instrument: instrumentExpectation(markerClass) };
}
