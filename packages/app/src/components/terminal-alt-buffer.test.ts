import type { Terminal } from '@xterm/xterm';
import { describe, expect, test } from 'vitest';

type TerminalConstructor = typeof import('@xterm/xterm')['Terminal'];

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

// Each deep path pins one independently patched runtime file. Variable
// specifiers also prevent a static-analysis pass from rewriting either import
// through the package's single entrypoint.
const runtimes: Array<{
  entry: string;
  loadTerminal: () => Promise<TerminalConstructor>;
}> = [
  {
    entry: 'CommonJS main (lib/xterm.js)',
    loadTerminal: async () => {
      const cjsEntry = '@xterm/xterm/lib/xterm.js';
      const cjsModule = await import(cjsEntry);
      return cjsModule.default.Terminal as TerminalConstructor;
    },
  },
  {
    entry: 'ESM module (lib/xterm.mjs)',
    loadTerminal: async () => {
      const esmEntry = '@xterm/xterm/lib/xterm.mjs';
      const esmModule = await import(esmEntry);
      return esmModule.Terminal as TerminalConstructor;
    },
  },
];

describe.each(runtimes)('xterm alternate buffer — $entry', ({ loadTerminal }) => {
  test('stays bounded to the viewport after the inactive buffer is resized down', async () => {
    const TerminalConstructor = await loadTerminal();
    const terminal = new TerminalConstructor({ cols: 80, rows: 24 });

    try {
      // Resize before entering the alternate screen so its buffer is still empty,
      // then write past the original 24-row capacity to make stale capacity visible.
      terminal.resize(80, 14);
      const scrollingOutput = Array.from({ length: 30 }, (_, index) => `line ${index}\r\n`).join(
        '',
      );

      await write(terminal, `\x1b[?1049h${scrollingOutput}`);

      expect(terminal.buffer.active.type).toBe('alternate');
      expect(terminal.buffer.alternate.length).toBeLessThanOrEqual(terminal.rows);
    } finally {
      terminal.dispose();
    }
  });
});
