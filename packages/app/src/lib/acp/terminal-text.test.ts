import { describe, expect, test } from 'vitest';
import { renderTerminalText, stripAnsi } from './terminal-text';

describe('stripAnsi', () => {
  test('removes SGR color sequences', () => {
    expect(stripAnsi('\x1b[32mPASS\x1b[0m suite')).toBe('PASS suite');
  });

  test('removes cursor movement and erase sequences', () => {
    expect(stripAnsi('progress\x1b[2K\x1b[1G100%')).toBe('progress100%');
  });

  test('removes OSC sequences (BEL- and ST-terminated)', () => {
    expect(stripAnsi('\x1b]0;window title\x07visible')).toBe('visible');
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  test('leaves plain text untouched', () => {
    expect(stripAnsi('just text — no escapes')).toBe('just text — no escapes');
  });
});

describe('renderTerminalText', () => {
  test('a carriage return restarts its line (progress bars show final frame)', () => {
    expect(renderTerminalText('downloading 10%\rdownloading 50%\rdownloading 100%\ndone')).toBe(
      'downloading 100%\ndone',
    );
  });

  test('strips ANSI and resolves \\r together', () => {
    expect(renderTerminalText('\x1b[33m10%\x1b[0m\r\x1b[32m100%\x1b[0m')).toBe('100%');
  });

  test('CRLF line endings keep their line content', () => {
    expect(renderTerminalText('hello\r\ndone\r\n')).toBe('hello\ndone\n');
  });

  test('a redraw with a trailing \\r still shows the final frame', () => {
    expect(renderTerminalText('10%\r100%\r\nnext')).toBe('100%\nnext');
  });
});
