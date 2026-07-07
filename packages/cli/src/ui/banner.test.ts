import { describe, expect, test } from 'bun:test';
import { renderBanner } from './banner.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code detection
const ANSI_RE = /\x1b\[[0-9;]*m/;
const VERSION = '0.0.1';

describe('renderBanner', () => {
  test('contains product name and version', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
    });
    expect(output).toContain('open-knowledge');
    expect(output).toContain(VERSION);
  });

  test('contains local URL', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
    });
    expect(output).toContain('http://localhost:3000');
    expect(output).toContain('Local:');
  });

  test('contains network URL when provided', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
      networkUrl: 'http://0.0.0.0:3000',
    });
    expect(output).toContain('Network:');
    expect(output).toContain('http://0.0.0.0:3000');
  });

  test('omits network line when not provided', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
    });
    expect(output).not.toContain('Network:');
  });

  test('labels primary URL as "Editor:" and shows API URL when both are provided', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
      apiUrl: 'http://localhost:52345',
    });
    expect(output).toContain('Editor:');
    expect(output).toContain('API:');
    expect(output).toContain('http://localhost:3000');
    expect(output).toContain('http://localhost:52345');
  });

  test('keeps "Local:" label when only localUrl is provided', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
    });
    expect(output).toContain('Local:');
    expect(output).not.toContain('Editor:');
    expect(output).not.toContain('API:');
  });

  test('contains Ctrl+C hint', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
    });
    expect(output).toContain('Ctrl+C');
  });

  test('renders next-steps lines when provided', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
      nextSteps: ['Open the Editor URL in your browser to start editing.'],
    });
    expect(output).toContain('Open the Editor URL in your browser to start editing.');
    // Still ends with the Ctrl+C hint after the next-steps section.
    expect(output).toContain('Ctrl+C');
  });

  test('omits next-steps section when not provided', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
    });
    expect(output).not.toContain('Open the Editor URL');
  });

  test('box lines stay consistent width with next-steps lines', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
      apiUrl: 'http://localhost:52345',
      nextSteps: ['Open the Editor URL in your browser to start editing.'],
    });
    const stripped = output
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
      .replace(/\x1b\[[0-9;]*m/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional OSC 8 hyperlink stripping
      .replace(/\x1b\]8;;[^\x07]*\x07/g, '');
    const lines = stripped.split('\n').filter((l) => l.trim().length > 0);
    const uniqueWidths = [...new Set(lines.map((l) => l.length))];
    expect(uniqueWidths).toHaveLength(1);
  });

  test('uses box-drawing characters', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
    });
    // Round box style from cli-boxes
    expect(output).toContain('╭');
    expect(output).toContain('╰');
    expect(output).toContain('│');
    expect(output).toContain('─');
  });

  test('box lines have consistent width', () => {
    const output = renderBanner({
      name: 'open-knowledge',
      version: VERSION,
      localUrl: 'http://localhost:3000',
      networkUrl: 'http://0.0.0.0:3000',
    });
    // Strip ANSI color codes and OSC 8 hyperlink sequences for width comparison
    const stripped = output
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
      .replace(/\x1b\[[0-9;]*m/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional OSC 8 hyperlink stripping
      .replace(/\x1b\]8;;[^\x07]*\x07/g, '');
    const lines = stripped.split('\n').filter((l) => l.trim().length > 0);
    const widths = lines.map((l) => l.length);
    // All lines should have the same visible width
    const uniqueWidths = [...new Set(widths)];
    expect(uniqueWidths).toHaveLength(1);
  });
});

describe('banner NO_COLOR behavior', () => {
  test('NO_COLOR=1 produces banner without ANSI codes', () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.env.NO_COLOR = '1';
        delete process.env.FORCE_COLOR;
        const { renderBanner } = require('./src/ui/banner.ts');
        console.log(renderBanner({
          name: 'open-knowledge',
          version: '0.0.1',
          localUrl: 'http://localhost:3000',
          networkUrl: 'http://0.0.0.0:3000',
        }));
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).not.toMatch(ANSI_RE);
    // Box characters should still be present
    expect(output).toContain('╭');
    expect(output).toContain('open-knowledge');
    expect(output).toContain('http://localhost:3000');
  });
});
