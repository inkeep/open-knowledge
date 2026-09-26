import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { V1_CODES, V1_RESULT_KIND_BY_CODE, v1ExitCode } from './supervision-json-v1.ts';

const path = resolve(
  import.meta.dir,
  '../../../../docs/content/reference/server-supervision-json.mdx',
);
const source = readFileSync(path, 'utf8');
const examples = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
  JSON.parse(match[1] ?? ''),
);

describe('published supervision JSON examples', () => {
  test('contains five complete, parseable examples with the implemented envelope', () => {
    expect(examples).toHaveLength(5);
    expect(examples.map((example) => example.command)).toEqual([
      'status',
      'status',
      'ps',
      'stop',
      'clean',
    ]);
    for (const example of examples) {
      expect(example.schemaVersion).toBe(1);
      expect(V1_CODES[example.command as keyof typeof V1_CODES]).toContain(example.result.code);
      expect(example.result.kind).toBe(
        V1_RESULT_KIND_BY_CODE[example.result.code as keyof typeof V1_RESULT_KIND_BY_CODE],
      );
      expect(v1ExitCode(example.result.kind)).toBe(
        example.result.kind === 'success'
          ? 0
          : example.result.kind === 'refused' || example.result.kind === 'error'
            ? 1
            : 0,
      );
      expect(example.result).toHaveProperty('detail');
    }
  });

  test('status examples include all required nullable fields and readiness shapes', () => {
    for (const example of examples.filter((item) => item.command === 'status')) {
      expect(Object.keys(example.project).sort()).toEqual(['resolution', 'root']);
      expect(Object.keys(example.server).sort()).toEqual([
        'alive',
        'capabilities',
        'identity',
        'launchKind',
        'lock',
        'process',
        'protocolVersion',
        'readiness',
        'runtime',
        'runtimeVersion',
      ]);
      expect(Object.keys(example.server.readiness).sort()).toEqual([
        'checkedAt',
        'degraded',
        'status',
      ]);
    }
    expect(examples[0].server.process).toMatchObject({ pid: 1234, port: 4242 });
    expect(Object.keys(examples[0].server.process).sort()).toEqual([
      'draining',
      'hostname',
      'pid',
      'port',
      'startedAt',
    ]);
    expect(Object.keys(examples[0].server.runtime).sort()).toEqual([
      'bind',
      'effectiveSince',
      'externalUrl',
      'idleShutdown',
      'port',
      'revision',
      'source',
    ]);
    expect(examples[0].server.readiness.status).toBe('ready');
    expect(examples[1].server).toMatchObject({
      process: null,
      alive: false,
      identity: null,
      runtime: null,
      readiness: { status: 'not-running' },
    });
  });

  test('inventory and mutation examples include their complete command fields', () => {
    expect(examples[2].servers).toEqual([]);
    expect(Object.keys(examples[3].target).sort()).toEqual(['kind', 'projectRoot', 'value']);
    expect(typeof examples[3].force).toBe('boolean');
    expect(Object.keys(examples[3].targets[0]).sort()).toEqual([
      'code',
      'detail',
      'lockPath',
      'pid',
      'port',
      'projectRoot',
      'serverInstanceId',
    ]);
    expect(Object.keys(examples[4].project).sort()).toEqual(['resolution', 'root']);
    expect(Object.keys(examples[4].targets[0]).sort()).toEqual(['code', 'detail', 'lockPath']);
    expect(examples[3].targets[0].code).toBe(examples[3].result.code);
    expect(examples[4].targets[0].code).toBe(examples[4].result.code);
  });

  test.each(Object.entries(V1_CODES))('documents every %s result code', (command, codes) => {
    const title =
      command === 'ps'
        ? 'Machine inventory'
        : command === 'stop'
          ? 'Stop decisions'
          : command === 'clean'
            ? 'Clean decisions'
            : 'Project status';
    const start = source.indexOf(`## ${title}`);
    const end = source.indexOf('\n## ', start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    const section = source.slice(start, end < 0 ? undefined : end);
    for (const code of codes) expect(section).toContain(`| \`${code}\` |`);
  });
});
