import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CHAIN_V1, EDITOR_TARGETS, type EditorMcpTarget } from './editors.ts';
import { writeEditorMcpConfig } from './init.ts';
import { removeOwnMcpEntry } from './mcp-config-removal.ts';

// Drive the real write spine against a temp Hermes `config.yaml`, exercising the
// format-preserving `yaml` document path end to end through
// `writeEditorMcpConfig`: comment/sibling preservation, the BOM/EOL/trailing-
// newline wrapper, register-vs-update labeling, decline-on-unparseable, and the
// reverse removal path. Hermes' whole config (models, tool filters) lives in
// this same file, so touching only OK's own entry is load-bearing.

let dir: string;

function tempFile(name: string): string {
  dir = mkdtempSync(join(tmpdir(), 'ok-yaml-surgical-'));
  return join(dir, name);
}

// Override `detectPath` too (not just `configPath`): Hermes is
// `offerOnlyWhenDetected`, so the availability gate probes the detect dir even
// under `skipAvailabilityCheck`. Point it at the temp dir so the gate passes
// deterministically instead of depending on a real `~/.hermes`.
function hermesTargetForFile(configPath: string): EditorMcpTarget {
  return {
    ...EDITOR_TARGETS.hermes,
    configPath: () => configPath,
    detectPath: () => dirname(configPath),
  };
}

function writeHermes(configPath: string) {
  return writeEditorMcpConfig(hermesTargetForFile(configPath), '', {
    mode: 'published',
    skipAvailabilityCheck: true,
  });
}

const PUBLISHED_CHAIN_ENTRY = { command: '/bin/sh', args: ['-l', '-c', CHAIN_V1] };

describe('surgical YAML MCP write', () => {
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('creates a fresh config with our entry when the file is absent', () => {
    const configPath = tempFile('config.yaml');
    const result = writeHermes(configPath);
    expect(result.action).toBe('written');

    const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(parsed.mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('inserts only our entry, preserving comments, siblings, and key order', () => {
    const configPath = tempFile('config.yaml');
    const original = [
      '# hand-written header',
      'model: hermes-4',
      'temperature: 0.7',
      '',
      'mcp_servers:',
      '  github:',
      '    command: npx',
      '    args: ["-y", "@modelcontextprotocol/server-github"]  # keep this note',
      '',
    ].join('\n');
    writeFileSync(configPath, original);

    const result = writeHermes(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    // Comments + block-style content survive; the sibling's inline comment is
    // preserved too. (yaml's AST round-trip may normalize whitespace INSIDE a
    // flow collection — `["-y","x"]` → `[ "-y", "x" ]` — but never drops the
    // comment or changes the value; the structural parse below is the fidelity
    // proof. This matches how OK edits its own config.yml via parseDocument.)
    expect(after).toContain('# hand-written header');
    expect(after).toContain('# keep this note');
    expect(after).toContain('temperature: 0.7');

    // Independent parse confirms data-equality: the sibling is untouched and our
    // entry is added under the same `mcp_servers` map with the published chain.
    const parsed = parseYaml(after);
    expect(parsed.model).toBe('hermes-4');
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.mcp_servers.github).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    expect(parsed.mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('creates the mcp_servers map when the file has none, keeping the prefix', () => {
    const configPath = tempFile('config.yaml');
    const original = '# my config\nmodel: hermes-4\n';
    writeFileSync(configPath, original);

    writeHermes(configPath);
    const after = readFileSync(configPath, 'utf-8');
    // Everything the user wrote survives verbatim; the new map is appended.
    expect(after).toContain('# my config');
    expect(after).toContain('model: hermes-4');
    expect(parseYaml(after).mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('handles an empty `mcp_servers:` scalar (null) without throwing', () => {
    const configPath = tempFile('config.yaml');
    // `mcp_servers:` with no body parses as Scalar(null); setIn must replace it
    // with a map rather than throwing "Expected YAML collection".
    writeFileSync(configPath, 'model: hermes-4\nmcp_servers:\n');

    const result = writeHermes(configPath);
    expect(result.action).toBe('written');
    const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(parsed.model).toBe('hermes-4');
    expect(parsed.mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('labels an existing OK entry update as overwritten', () => {
    const configPath = tempFile('config.yaml');
    writeFileSync(configPath, 'mcp_servers:\n  open-knowledge:\n    command: old\n    args: []\n');

    const result = writeHermes(configPath);
    expect(result.action).toBe('overwritten');
    expect(parseYaml(readFileSync(configPath, 'utf-8')).mcp_servers['open-knowledge']).toEqual(
      PUBLISHED_CHAIN_ENTRY,
    );
  });

  it('is idempotent: a second write does not churn the file', () => {
    const configPath = tempFile('config.yaml');
    writeHermes(configPath);
    const first = readFileSync(configPath, 'utf-8');
    const result = writeHermes(configPath);
    // Entry already present + current: labeled overwritten, bytes unchanged.
    expect(result.action).toBe('overwritten');
    expect(readFileSync(configPath, 'utf-8')).toBe(first);
  });

  it('preserves a leading UTF-8 BOM byte-for-byte', () => {
    const configPath = tempFile('config.yaml');
    // Explicit escape — never an invisible BOM literal in source.
    const original = '\uFEFF# bom config\nmodel: hermes-4\n';
    writeFileSync(configPath, original);

    const result = writeHermes(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after).toContain('# bom config');
    expect(parseYaml(after).mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it('preserves CRLF line endings elsewhere', () => {
    const configPath = tempFile('config.yaml');
    const original = '# crlf config\r\nmodel: hermes-4\r\n';
    writeFileSync(configPath, original);

    const result = writeHermes(configPath);
    expect(result.action).toBe('written');

    const after = readFileSync(configPath, 'utf-8');
    // Every newline in the file is CRLF — no lone LF leaked in.
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(after).toContain('# crlf config');
    expect(parseYaml(after).mcp_servers['open-knowledge']).toEqual(PUBLISHED_CHAIN_ENTRY);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a user-tightened file mode (0600) on an in-place rewrite',
    () => {
      const configPath = tempFile('config.yaml');
      writeFileSync(configPath, '# my hermes config\nmodel: hermes-4\n');
      // A tightened Hermes config (it can carry provider tokens under
      // `mcp_servers.*.env`) must not be widened when OK adds its entry.
      chmodSync(configPath, 0o600);

      const result = writeHermes(configPath);
      expect(result.action).toBe('written');
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    },
  );

  it('declines a present, unparseable config (left byte-unchanged)', () => {
    const configPath = tempFile('config.yaml');
    // Bad indentation / structure the yaml parser reports as an error.
    const original = 'model: hermes-4\n  bad: : : indent\n\t- mixed\n';
    writeFileSync(configPath, original);

    const result = writeHermes(configPath);
    expect(result.action).toBe('declined');
    // The file OK couldn't safely parse is left exactly as it was.
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('removes only our own entry, preserving the sibling server', () => {
    const configPath = tempFile('config.yaml');
    const original = [
      '# hand-written header',
      'model: hermes-4',
      'mcp_servers:',
      '  github:',
      '    command: npx',
      '    args: ["-y", "@modelcontextprotocol/server-github"]',
      '',
    ].join('\n');
    writeFileSync(configPath, original);
    writeHermes(configPath);

    const outcome = removeOwnMcpEntry(hermesTargetForFile(configPath), '', undefined, configPath);
    expect(outcome.kind).toBe('removed');

    const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
    // OK's entry is gone; the user's sibling + comment survive.
    expect(parsed.mcp_servers['open-knowledge']).toBeUndefined();
    expect(parsed.mcp_servers.github).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    expect(readFileSync(configPath, 'utf-8')).toContain('# hand-written header');
  });

  it('leaves a foreign server sharing our key untouched on removal', () => {
    const configPath = tempFile('config.yaml');
    // A server squatting on the `open-knowledge` name that is NOT OK's managed
    // chain shape must be preserved, never deleted.
    writeFileSync(
      configPath,
      'mcp_servers:\n  open-knowledge:\n    command: not-ok\n    args: [evil]\n',
    );

    const outcome = removeOwnMcpEntry(hermesTargetForFile(configPath), '', undefined, configPath);
    expect(outcome.kind).toBe('left-foreign');
    expect(parseYaml(readFileSync(configPath, 'utf-8')).mcp_servers['open-knowledge']).toEqual({
      command: 'not-ok',
      args: ['evil'],
    });
  });
});
