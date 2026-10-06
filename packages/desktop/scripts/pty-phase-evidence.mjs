import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function readPtyPhaseRecords(text) {
  const records = [];
  for (const line of text.split(/\r?\n/u)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const candidates = entry?.event === 'pty-phase-trace' ? entry.records : [entry];
    if (!Array.isArray(candidates)) continue;
    for (const record of candidates) {
      if (
        record?.event === 'pty-phase' &&
        typeof record.producer === 'string' &&
        typeof record.phase === 'string' &&
        ['begin', 'end', 'error', 'point'].includes(record.edge) &&
        Number.isFinite(record.atMs) &&
        Number.isInteger(record.sequence)
      )
        records.push(record);
    }
  }
  return records;
}

function measurePtyIntervals(records) {
  const spawnEnds = new Map();
  const firstOutputs = new Map();
  const intervals = [];
  const interval = (from, to) => ({
    producer: to.producer,
    pid: to.pid,
    ptyId: to.ptyId,
    from: from.phase,
    to: to.phase,
    durationMs: to.atMs - from.atMs,
    fromSequence: from.sequence,
    toSequence: to.sequence,
  });
  for (const record of records) {
    const key = JSON.stringify([record.producer, record.pid, record.timeOriginMs, record.ptyId]);
    if (record.phase === 'pty-spawn' && record.edge === 'end') spawnEnds.set(key, record);
    else if (record.phase === 'pty-first-output' && record.currentSession === true) {
      const spawnEnd = spawnEnds.get(key);
      if (spawnEnd) intervals.push(interval(spawnEnd, record));
      firstOutputs.set(key, record);
    } else if (record.phase === 'pty-first-forward') {
      const firstOutput = firstOutputs.get(key);
      if (firstOutput) intervals.push(interval(firstOutput, record));
    }
  }
  return intervals;
}

const isOutcomeWait = (span) => span.producer === 'renderer' && span.phase === 'evaluation';

export function summarizePtyPhases(records) {
  const pending = new Map();
  const completed = [];
  const incomplete = [];
  for (const record of records) {
    const key = JSON.stringify([
      record.producer,
      record.pid,
      record.timeOriginMs,
      record.phase,
      record.scope ?? record.ptyId,
    ]);
    if (record.edge === 'begin') {
      if (pending.has(key)) incomplete.push(pending.get(key));
      pending.set(key, record);
    } else if (record.edge === 'end' || record.edge === 'error') {
      const begin = pending.get(key);
      if (begin) {
        completed.push({
          producer: record.producer,
          pid: record.pid,
          phase: record.phase,
          scope: record.scope,
          ptyId: record.ptyId,
          outcome: record.edge,
          durationMs: record.atMs - begin.atMs,
          beginSequence: begin.sequence,
          endSequence: record.sequence,
        });
        pending.delete(key);
      } else incomplete.push(record);
    }
  }
  incomplete.push(...pending.values());
  return {
    completed,
    incomplete,
    longestCompleted: completed
      .filter((span) => !isOutcomeWait(span))
      .reduce(
        (longest, span) => (!longest || span.durationMs > longest.durationMs ? span : longest),
        null,
      ),
    intervals: measurePtyIntervals(records),
    missingProducers: ['renderer', 'main', 'utility'].filter(
      (producer) => !records.some((record) => record.producer === producer),
    ),
    limited: records.some((record) => record.phase === 'trace-limit'),
    droppedWrites: records.filter((record) => record.droppedWrites > 0),
    clockScope:
      'Durations compare marks within one process only; wall/time-origin anchors across processes are approximate.',
  };
}

const INCIDENT_FILES = ['bug-report-main-thread-stall.json', 'bug-report-main-exit.json'];
const WATCHDOG_FILES = [
  'bug-report-main-thread-liveness.json',
  'bug-report-dirty-shutdown.json',
  ...INCIDENT_FILES,
];

export function preservePtyEvidence({
  diagnosticsDir,
  logPath,
  logDir,
  userDataDir,
  launchedAt,
  appPid,
  driver,
}) {
  mkdirSync(diagnosticsDir, { recursive: true });
  const destination = mkdtempSync(join(diagnosticsDir, 'run-'));
  const files = [];
  const capture = (source, target) => {
    try {
      const bytes = readFileSync(source);
      writeFileSync(join(destination, target), bytes);
      files.push({ source, target, status: 'copied', bytes: bytes.length });
      return bytes.toString('utf8');
    } catch (error) {
      files.push({
        source,
        target,
        status: error.code === 'ENOENT' ? 'missing' : 'unavailable',
        error: error.message,
      });
      return '';
    }
  };
  const appOutput = capture(logPath, 'app-stdio.log');
  writeFileSync(join(destination, 'driver.stdout.log'), driver?.stdout ?? '');
  writeFileSync(join(destination, 'driver.stderr.log'), driver?.stderr ?? '');
  const observed = [
    ...readPtyPhaseRecords(appOutput),
    ...readPtyPhaseRecords(driver?.stdout ?? ''),
    ...readPtyPhaseRecords(driver?.stderr ?? ''),
  ];
  const ownPaths = (records) =>
    records.findLast(
      (record) =>
        record.producer === 'main' &&
        record.pid === appPid &&
        record.phase === 'paths' &&
        record.wallTimeMs >= launchedAt,
    );
  const stdioPaths = ownPaths(observed);
  const actualLogDir = typeof stdioPaths?.logDir === 'string' ? stdioPaths.logDir : logDir;
  mkdirSync(join(destination, 'desktop-logs'));
  try {
    const names = readdirSync(actualLogDir).filter((name) =>
      /^desktop.*\.log(?:\.\d+)?$/u.test(name),
    );
    if (names.length === 0) {
      files.push({
        source: actualLogDir,
        target: 'desktop-logs',
        status: 'missing',
        error: 'no file matching desktop*.log',
      });
    }
    for (const name of names) {
      const text = capture(join(actualLogDir, name), join('desktop-logs', name));
      observed.push(
        ...readPtyPhaseRecords(text).filter((record) => record.wallTimeMs >= launchedAt),
      );
    }
  } catch (error) {
    files.push({
      source: actualLogDir,
      target: 'desktop-logs',
      status: 'unavailable',
      error: error.message,
    });
  }
  const paths = ownPaths(observed);
  const actualUserData = typeof paths?.userDataDir === 'string' ? paths.userDataDir : userDataDir;
  mkdirSync(join(destination, 'user-data'));
  for (const name of WATCHDOG_FILES) capture(join(actualUserData, name), join('user-data', name));
  const incidentSources = new Set(INCIDENT_FILES.map((name) => join(actualUserData, name)));
  const unique = new Map(
    observed.map((record) => [
      JSON.stringify([record.producer, record.pid, record.timeOriginMs, record.sequence]),
      record,
    ]),
  );
  const records = [...unique.values()].sort(
    (a, b) =>
      a.producer.localeCompare(b.producer) ||
      String(a.pid).localeCompare(String(b.pid)) ||
      (a.timeOriginMs ?? 0) - (b.timeOriginMs ?? 0) ||
      a.sequence - b.sequence,
  );
  writeFileSync(
    join(destination, 'phase-trace.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
  writeFileSync(
    join(destination, 'phase-summary.json'),
    JSON.stringify(summarizePtyPhases(records), null, 2),
  );
  const manifest = {
    launchedAt,
    appPid,
    logDir: actualLogDir,
    userDataDir: actualUserData,
    userDataSource: paths ? 'app-record' : 'requested-unconfirmed',
    driver: driver
      ? { status: driver.status, signal: driver.signal, error: driver.error?.message }
      : { status: null, observation: 'not-returned' },
    collection: files.some(
      (file) =>
        file.status === 'unavailable' ||
        (file.status === 'missing' && !incidentSources.has(file.source)),
    )
      ? 'partial'
      : 'copied',
    files,
    phaseRecords: records.length,
    duplicatePhaseRecords: observed.length - records.length,
    rendererCollectionUnavailable: (driver?.stderr ?? '').includes(
      '"event": "pty-phase-trace-unavailable"',
    ),
  };
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return destination;
}
