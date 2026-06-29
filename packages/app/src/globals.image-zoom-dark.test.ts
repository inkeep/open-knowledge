
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

describe('image-zoom modal overlay — dark theme override', () => {
  test('globals.css contains a .dark-scoped rule targeting the rmiz visible-state overlay', () => {
    expect(CSS).toMatch(/\.dark\s+[^{}]*\[data-rmiz-modal-overlay="visible"\][^{]*\{/);
  });

  test('the dark-mode rmiz overlay rule references a theme token, not a hardcoded color', () => {
    const ruleMatch = CSS.match(
      /\.dark\s+[^{}]*\[data-rmiz-modal-overlay="visible"\][^{]*\{([^}]+)\}/,
    );
    expect(ruleMatch).not.toBeNull();
    const body = ruleMatch?.[1] ?? '';

    expect(body).toMatch(/background-color\s*:/);
    expect(body).toMatch(/var\(--[a-z0-9-]+\)/);
    expect(body).toMatch(/var\(--background\)/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/rgba?\(\s*\d/);
  });
});
