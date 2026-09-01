import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { resolveUninstallEntryTarget } from '../../src/main/uninstall-window.ts';

const UNINSTALL_HTML_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../app/uninstall.html',
);

const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

function inlineEntryScripts(): string[] {
  const html = readFileSync(UNINSTALL_HTML_PATH, 'utf8');
  return [...html.matchAll(INLINE_SCRIPT_RE)].map((match) => match[1] ?? '');
}

function runEntryScripts(search: string): Set<string> {
  const classes = new Set<string>();
  const sandbox = {
    URLSearchParams,
    location: { search },
    document: {
      documentElement: {
        classList: {
          add: (name: string) => {
            classes.add(name);
          },
        },
      },
    },
  };
  for (const script of inlineEntryScripts()) runInNewContext(script, sandbox);
  return classes;
}

function entrySearchFor(theme: 'light' | 'dark'): string {
  const target = resolveUninstallEntryTarget(
    {
      devServerUrl: null,
      isPackaged: true,
      resourcesPath: '/Applications/OpenKnowledge.app/Contents/Resources',
      mainDir: '/Applications/OpenKnowledge.app/Contents/Resources/app.asar/out/main',
    },
    theme,
  );
  if (target.kind !== 'file') throw new Error('expected the packaged file target');
  return `?${new URLSearchParams(target.query).toString()}`;
}

describe('uninstall.html theme stamp', () => {
  it('has an inline script to run', () => {
    expect(inlineEntryScripts().length).toBeGreaterThan(0);
  });

  it('applies dark when main resolved the app to dark', () => {
    expect(runEntryScripts(entrySearchFor('dark')).has('dark')).toBe(true);
  });

  it('stays light when main resolved the app to light', () => {
    expect(runEntryScripts(entrySearchFor('light')).has('dark')).toBe(false);
  });

  it('stays light with no query rather than reading the OS preference', () => {
    expect(runEntryScripts('').has('dark')).toBe(false);
  });

  it('stays light on an unrecognized value', () => {
    expect(runEntryScripts('?theme=sepia').has('dark')).toBe(false);
  });
});
