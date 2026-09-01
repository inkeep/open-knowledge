export interface BootTimings {
  startedAt: string;
  httpListenMs?: number;
  seedWalkMs?: number;
  indexesMs?: number;
  generatedIndexSweepMs?: number;
  readyMs?: number;
  fileCount?: number;
  generatedIndexCount?: number;
}

let current: BootTimings | undefined;
let bootStartMono: number | undefined;

export function startBootTimings(startedAt: string = new Date().toISOString()): void {
  current = { startedAt };
  bootStartMono = performance.now();
}

export function bootElapsedMs(): number | undefined {
  if (bootStartMono === undefined) return undefined;
  return Math.round(performance.now() - bootStartMono);
}

export function recordBootPhase(
  name: Exclude<keyof BootTimings, 'startedAt' | 'fileCount' | 'generatedIndexCount'>,
  ms: number,
): void {
  if (!current) return;
  current[name] = ms;
}

export function setBootField(name: 'fileCount' | 'generatedIndexCount', value: number): void {
  if (!current) return;
  current[name] = value;
}

export function getBootTimings(): BootTimings | undefined {
  return current;
}

export function resetBootTimingsForTest(): void {
  current = undefined;
  bootStartMono = undefined;
}
