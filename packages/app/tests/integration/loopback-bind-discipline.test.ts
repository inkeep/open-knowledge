import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from '../../../../test-support/test-only-source-file.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..', '..');
const SCAN_ROOTS = [__dirname, join(PACKAGE_ROOT, 'tests', 'stress')];

const SELF_BASENAME = basename(fileURLToPath(import.meta.url));

interface FileLines {
  path: string;
  lines: string[];
}

function listScannedFiles(): FileLines[] {
  const out: FileLines[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name === SELF_BASENAME) continue;
      out.push({
        path: relative(PACKAGE_ROOT, abs),
        lines: readFileSync(abs, 'utf-8').split('\n'),
      });
    }
  }
  for (const root of SCAN_ROOTS) walk(root);
  return out;
}

function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

const LOOPBACK_HOST_LITERAL = /['"](?:127\.0\.0\.1|::1)['"]/;

export function findNonLoopbackListenCalls(lines: string[]): Array<{ line: number; text: string }> {
  const violations: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentOnlyLine(line)) continue;
    const idx = line.indexOf('.listen(');
    if (idx === -1) continue;
    let window = line.slice(idx);
    for (let j = i + 1; j <= i + 3 && !window.includes(')') && j < lines.length; j++) {
      window += `\n${lines[j] ?? ''}`;
    }
    const paren = window.indexOf(')');
    if (paren !== -1) window = window.slice(0, paren + 1);
    if (!LOOPBACK_HOST_LITERAL.test(window)) {
      violations.push({ line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

interface ListenExemption {
  path: string;
  call: string;
  reason: string;
}

const RECORDING_OWNERSHIP_CASE = 'tests/stress/_helpers/port-ownership/recording.ownership-case.ts';

const LISTEN_EXEMPTIONS: readonly ListenExemption[] = [
  {
    path: RECORDING_OWNERSHIP_CASE,
    call: 'server.listen(port, host);',
    reason:
      "Wildcard occupant bound to '0.0.0.0': holds the candidate port on the wildcard address so Vite's availability preflight skips it; it is never dialed.",
  },
  {
    path: RECORDING_OWNERSHIP_CASE,
    call: 'await vite.listen();',
    reason:
      "Vite's listen(port?, isRestart?) accepts no host; the server binds the loopback host configured in server.host.",
  },
];

function findUnexemptedListenCalls(
  path: string,
  lines: string[],
): Array<{ line: number; text: string }> {
  const remaining = LISTEN_EXEMPTIONS.filter((exemption) => exemption.path === path);
  return findNonLoopbackListenCalls(lines).filter((violation) => {
    const match = remaining.findIndex((exemption) => exemption.call === violation.text);
    if (match === -1) return true;
    remaining.splice(match, 1);
    return false;
  });
}

function findStaleListenExemptions(files: readonly FileLines[]): ListenExemption[] {
  const unclaimed = new Map(
    files.map((file) => [file.path, findNonLoopbackListenCalls(file.lines).map((v) => v.text)]),
  );
  return LISTEN_EXEMPTIONS.filter((exemption) => {
    const calls = unclaimed.get(exemption.path) ?? [];
    const match = calls.indexOf(exemption.call);
    if (match === -1) return true;
    calls.splice(match, 1);
    return false;
  });
}

const AMBIGUOUS_LOCALHOST_DIAL = /\b(?:https?|wss?):\/\/localhost:\$\{/;

export function findAmbiguousLocalhostDials(
  lines: string[],
): Array<{ line: number; text: string }> {
  const violations: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentOnlyLine(line)) continue;
    if (AMBIGUOUS_LOCALHOST_DIAL.test(line)) {
      violations.push({ line: i + 1, text: line.trim() });
    }
  }
  return violations;
}

describe('loopback bind discipline (app test sources)', () => {
  const files = listScannedFiles();

  test('there are test files to scan (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path.endsWith('integration/test-harness.ts'))).toBe(true);
    expect(files.some((f) => f.path.endsWith('_helpers/server-process.ts'))).toBe(true);
    expect(files.some((f) => isTestOnlySourceFile(f.path, 'playwright'))).toBe(true);
  });

  test('every .listen( call binds an explicit loopback host literal', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const v of findUnexemptedListenCalls(file.path, file.lines)) {
        violations.push(`  ${file.path}:${v.line}    ${v.text}`);
      }
    }
    expect(
      violations,
      `Hostless rig bind found — a bare listen(0) binds the IPv6 wildcard '::', whose loopback-specific ` +
        `port slots stay silently bindable by foreign processes; their listeners then intercept this rig's ` +
        `localhost dials (the rotating integration-suite flake). Bind a loopback-specific host ` +
        `(e.g. listen(0, '127.0.0.1', cb)) and dial the literal from server.address():\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  test('no interpolated-port localhost dial URLs', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const v of findAmbiguousLocalhostDials(file.lines)) {
        violations.push(`  ${file.path}:${v.line}    ${v.text}`);
      }
    }
    expect(
      violations,
      `Ambiguous-name rig dial found — 'localhost' resolves '::1'-first, exactly the loopback-specific slot ` +
        `a foreign process can hold while the rig sits on a wildcard (or single-family) bind. Dial the ` +
        `literal address the rig actually bound (a harness-advertised base URL, or ` +
        `http://127.0.0.1:\${port}):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  test('listen predicate fires on planted violations and not on adjacent negatives', () => {
    expect(findNonLoopbackListenCalls(['  s.listen(0, () => {']).length).toBe(1);
    expect(
      findNonLoopbackListenCalls(['    httpServer.listen(port, () => resolve());']).length,
    ).toBe(1);

    expect(findNonLoopbackListenCalls(["  server.listen(0, '127.0.0.1', resolve);"]).length).toBe(
      0,
    );
    expect(findNonLoopbackListenCalls(["  s.listen(port, '::1', cb);"]).length).toBe(0);

    expect(
      findNonLoopbackListenCalls(['  server.listen(', '    0,', "    '127.0.0.1',", '    cb)'])
        .length,
    ).toBe(0);

    expect(findNonLoopbackListenCalls(['  // before httpServer.listen() resolves']).length).toBe(0);
    expect(
      findNonLoopbackListenCalls([' * boot scan runs BEFORE httpServer.listen().']).length,
    ).toBe(0);

    expect(findNonLoopbackListenCalls(['  s.listen(port, host, cb);']).length).toBe(1);

    expect(findNonLoopbackListenCalls(["  s.listen(0, '0.0.0.0', cb);"]).length).toBe(1);
  });

  test('listen exemptions admit each keyed call once in its own file and nowhere else', () => {
    const exemptedPath = 'tests/stress/_helpers/port-ownership/recording.ownership-case.ts';
    const exemptedCalls = ['      server.listen(port, host);', '        await vite.listen();'];

    expect(findNonLoopbackListenCalls(exemptedCalls).length).toBe(2);
    expect(findUnexemptedListenCalls(exemptedPath, exemptedCalls)).toEqual([]);

    expect(
      findUnexemptedListenCalls(
        'tests/stress/_helpers/port-ownership/startup.ownership-case.ts',
        exemptedCalls,
      ).length,
    ).toBe(2);
    expect(
      findUnexemptedListenCalls('tests/integration/recording.ownership-case.ts', exemptedCalls)
        .length,
    ).toBe(2);

    expect(
      findUnexemptedListenCalls(exemptedPath, [
        ...exemptedCalls,
        '  s.listen(0, cb);',
        "  s.listen(0, '0.0.0.0', cb);",
      ]),
    ).toEqual([
      { line: 3, text: 's.listen(0, cb);' },
      { line: 4, text: "s.listen(0, '0.0.0.0', cb);" },
    ]);

    expect(findUnexemptedListenCalls(exemptedPath, [...exemptedCalls, ...exemptedCalls])).toEqual([
      { line: 3, text: 'server.listen(port, host);' },
      { line: 4, text: 'await vite.listen();' },
    ]);
  });

  test('every listen exemption still matches a call in its own file', () => {
    expect(
      findStaleListenExemptions(files).map(
        (exemption) => `  ${exemption.path}    ${exemption.call}`,
      ),
      'These LISTEN_EXEMPTIONS entries match no non-loopback .listen( call in their own file: ' +
        'the call changed or was removed. Delete the entry, or update its call text',
    ).toEqual([]);
  });

  test('stale exemptions are reported for a removed, rebound or relocated call and not for the live shape', () => {
    const exemptedPath = 'tests/stress/_helpers/port-ownership/recording.ownership-case.ts';
    const occupant = '      server.listen(port, host);';
    const viteListen = '        await vite.listen();';

    expect(
      findStaleListenExemptions([{ path: exemptedPath, lines: [occupant, viteListen] }]),
    ).toEqual([]);

    expect(
      findStaleListenExemptions([{ path: exemptedPath, lines: [occupant] }]).map((e) => e.call),
    ).toEqual(['await vite.listen();']);
    expect(
      findStaleListenExemptions([
        { path: exemptedPath, lines: ["      server.listen(port, '127.0.0.1');", viteListen] },
      ]).map((e) => e.call),
    ).toEqual(['server.listen(port, host);']);
    expect(
      findStaleListenExemptions([
        { path: exemptedPath, lines: [occupant, '        // await vite.listen();'] },
      ]).map((e) => e.call),
    ).toEqual(['await vite.listen();']);

    expect(
      findStaleListenExemptions([
        {
          path: 'tests/stress/_helpers/port-ownership/startup.ownership-case.ts',
          lines: [occupant, viteListen],
        },
      ]).length,
    ).toBe(2);
    expect(findStaleListenExemptions([]).length).toBe(2);
  });

  test('dial predicate fires on planted violations and not on adjacent negatives', () => {
    expect(
      findAmbiguousLocalhostDials([
        `  const res = await fetch(\`http://localhost:\${server.port}/api/documents\`);`,
      ]).length,
    ).toBe(1);
    expect(
      findAmbiguousLocalhostDials([`    url: \`ws://localhost:\${port}/collab\`,`]).length,
    ).toBe(1);

    expect(
      findAmbiguousLocalhostDials([`  const res = await fetch(\`http://127.0.0.1:\${port}/x\`);`])
        .length,
    ).toBe(0);

    expect(
      findAmbiguousLocalhostDials(["  expect(url).toBe('ws://localhost:7777/collab');"]).length,
    ).toBe(0);

    expect(findAmbiguousLocalhostDials([`  // dials http://localhost:\${port} today`]).length).toBe(
      0,
    );

    expect(findAmbiguousLocalhostDials(["  host: 'localhost:5173',"]).length).toBe(0);
  });
});
