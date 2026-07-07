import { describe, expect, test } from 'bun:test';

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code detection
const ANSI_RE = /\x1b\[[0-9;]*m/;

describe('color helpers', () => {
  test('all semantic helpers return strings', async () => {
    const { error, warning, success, info, dim, accent } = await import('./colors.ts');
    expect(typeof error('x')).toBe('string');
    expect(typeof warning('x')).toBe('string');
    expect(typeof success('x')).toBe('string');
    expect(typeof info('x')).toBe('string');
    expect(typeof dim('x')).toBe('string');
    expect(typeof accent('x')).toBe('string');
  });

  test('helpers preserve the input text', async () => {
    const { error, info, dim } = await import('./colors.ts');
    expect(error('hello')).toContain('hello');
    expect(info('path/to/file')).toContain('path/to/file');
    expect(dim('secondary')).toContain('secondary');
  });

  test('isColorEnabled returns boolean', async () => {
    const { isColorEnabled } = await import('./colors.ts');
    expect(typeof isColorEnabled()).toBe('boolean');
  });
});

describe('NO_COLOR env var suppresses ANSI codes', () => {
  test('NO_COLOR=1 produces zero ANSI escape codes', async () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.env.NO_COLOR = '1';
        delete process.env.FORCE_COLOR;
        const { error, warning, success, info, dim, accent, isColorEnabled } = require('./src/ui/colors.ts');
        console.log(error('ERR'));
        console.log(warning('WARN'));
        console.log(success('OK'));
        console.log(info('INFO'));
        console.log(dim('DIM'));
        console.log(accent('BOLD'));
        console.log('enabled=' + isColorEnabled());
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).not.toMatch(ANSI_RE);
    expect(output).toContain('ERR');
    expect(output).toContain('enabled=false');
  });
});

describe('FORCE_COLOR env var enables colors', () => {
  test('FORCE_COLOR=1 produces ANSI escape codes', async () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.env.FORCE_COLOR = '1';
        delete process.env.NO_COLOR;
        const { error, isColorEnabled } = require('./src/ui/colors.ts');
        console.log(error('ERR'));
        console.log('enabled=' + isColorEnabled());
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).toMatch(ANSI_RE);
    expect(output).toContain('enabled=true');
  });
});

describe('--no-color argv detection', () => {
  test('--no-color sets NO_COLOR and deletes FORCE_COLOR', async () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        // Simulate --no-color in argv
        process.argv.push('--no-color');
        process.env.FORCE_COLOR = '1';

        // Run the same detection logic as cli.ts
        if (process.argv.includes('--no-color')) {
          process.env.NO_COLOR = '1';
          delete process.env.FORCE_COLOR;
        }

        const { error, isColorEnabled } = require('./src/ui/colors.ts');
        console.log(error('ERR'));
        console.log('enabled=' + isColorEnabled());
        console.log('NO_COLOR=' + process.env.NO_COLOR);
        console.log('FORCE_COLOR=' + (process.env.FORCE_COLOR ?? 'undefined'));
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).not.toMatch(ANSI_RE);
    expect(output).toContain('enabled=false');
    expect(output).toContain('NO_COLOR=1');
    expect(output).toContain('FORCE_COLOR=undefined');
  });

  test('--color sets FORCE_COLOR and deletes NO_COLOR', async () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.argv.push('--color');
        process.env.NO_COLOR = '1';

        if (process.argv.includes('--color')) {
          process.env.FORCE_COLOR = '1';
          delete process.env.NO_COLOR;
        }

        const { error, isColorEnabled } = require('./src/ui/colors.ts');
        console.log(error('ERR'));
        console.log('enabled=' + isColorEnabled());
        console.log('NO_COLOR=' + (process.env.NO_COLOR ?? 'undefined'));
        console.log('FORCE_COLOR=' + process.env.FORCE_COLOR);
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).toMatch(ANSI_RE);
    expect(output).toContain('enabled=true');
    expect(output).toContain('NO_COLOR=undefined');
    expect(output).toContain('FORCE_COLOR=1');
  });

  test('--no-color overrides FORCE_COLOR in env', async () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.argv.push('--no-color');

        // Same detection as cli.ts
        if (process.argv.includes('--no-color')) {
          process.env.NO_COLOR = '1';
          delete process.env.FORCE_COLOR;
        } else if (process.argv.includes('--color')) {
          process.env.FORCE_COLOR = '1';
          delete process.env.NO_COLOR;
        }

        const { error, isColorEnabled } = require('./src/ui/colors.ts');
        console.log(error('ERR'));
        console.log('enabled=' + isColorEnabled());
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).not.toMatch(ANSI_RE);
    expect(output).toContain('enabled=false');
  });

  test('--no-color wins when both --no-color and --color are present', async () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.argv.push('--no-color', '--color');

        // Same detection as cli.ts — --no-color always wins
        if (process.argv.includes('--no-color')) {
          process.env.NO_COLOR = '1';
          delete process.env.FORCE_COLOR;
        } else if (process.argv.includes('--color')) {
          process.env.FORCE_COLOR = '1';
          delete process.env.NO_COLOR;
        }

        const { error, isColorEnabled } = require('./src/ui/colors.ts');
        console.log(error('ERR'));
        console.log('enabled=' + isColorEnabled());
        console.log('NO_COLOR=' + process.env.NO_COLOR);
        console.log('FORCE_COLOR=' + (process.env.FORCE_COLOR ?? 'undefined'));
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).not.toMatch(ANSI_RE);
    expect(output).toContain('enabled=false');
    expect(output).toContain('NO_COLOR=1');
    expect(output).toContain('FORCE_COLOR=undefined');
  });
});

describe('link() OSC 8 hyperlinks', () => {
  test('link() produces OSC 8 escape sequence when colors enabled', () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.env.FORCE_COLOR = '1';
        delete process.env.NO_COLOR;
        const { link } = require('./src/ui/colors.ts');
        const output = link('click me', 'https://example.com');
        process.stdout.write(output);
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
    });
    const output = result.stdout.toString();
    // Verify OSC 8 structure: ESC]8;;<url>BEL<text>ESC]8;;BEL
    expect(output).toContain('\x1b]8;;https://example.com\x07');
    expect(output).toContain('click me');
    expect(output).toContain('\x1b]8;;\x07');
  });

  test('link() returns plain text when NO_COLOR is set', () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `
        process.env.NO_COLOR = '1';
        delete process.env.FORCE_COLOR;
        const { link } = require('./src/ui/colors.ts');
        const output = link('click me', 'https://example.com');
        process.stdout.write(output);
        `,
      ],
      cwd: import.meta.dir.replace('/src/ui', ''),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
    });
    const output = result.stdout.toString();
    expect(output).toBe('click me');
    // No OSC 8 sequences
    expect(output).not.toContain('\x1b]8;;');
  });
});
