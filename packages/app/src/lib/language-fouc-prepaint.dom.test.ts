/**
 * Executes the real language pre-paint script out of `index.html` against
 * caches written by the real writer, and asserts the `<html>` state it produces.
 *
 * This is the only coverage of that path. The script cannot import anything —
 * it runs before any bundle — so it reads the cache's field names (`locale`,
 * `dir`) as string literals with no compile-time link to
 * `use-apply-config-language.ts`. Renaming a field there updates every
 * TypeScript consumer while this script silently reads `undefined` and paints
 * the wrong language on every load, with nothing else in the suite going red.
 * Feeding real writer output through the real script is what couples the two.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  type ApplyLanguageInput,
  applyLanguageToDom,
  LANGUAGE_CACHE_STORAGE_KEY,
} from './use-apply-config-language';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The language pre-paint script, lifted verbatim from `index.html`. Identified
 * by the cache key it reads rather than by position, so an added `<script>`
 * can't silently shift which one is under test.
 */
function prePaintScript(): string {
  const html = readFileSync(resolve(here, '../../index.html'), 'utf8');
  const body = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s?.includes(LANGUAGE_CACHE_STORAGE_KEY));
  if (!body) throw new Error('pre-paint language script not found in index.html');
  return body;
}

let script: string;

beforeAll(() => {
  if (typeof localStorage === 'undefined') {
    (globalThis as { localStorage?: Storage }).localStorage = window.localStorage;
  }
  script = prePaintScript();
});

function runPrePaint(): void {
  new Function(script)();
}

function reset(): void {
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  localStorage.clear();
}

/** Seed the cache exactly as the app writes it — no hand-built JSON. */
function seed(input: ApplyLanguageInput): void {
  applyLanguageToDom(input);
  // Only the cache survives a reload; the live attributes do not.
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
}

const painted = () => ({
  lang: document.documentElement.getAttribute('lang'),
  dir: document.documentElement.getAttribute('dir'),
});

describe('language pre-paint script', () => {
  beforeEach(reset);

  test('has no inner newlines', () => {
    // Biome's HTML formatter reindents inline-script content on every pass, so
    // a multi-line body grows by four spaces per run and pre-commit never
    // reaches a fixed point. Nothing at runtime can catch that.
    expect(script).not.toContain('\n');
  });

  test('reads the writer’s own cache — the field-name contract holds end to end', () => {
    seed({ preference: 'es', locale: 'es' });
    runPrePaint();
    expect(painted()).toEqual({ lang: 'es', dir: 'ltr' });
  });

  test('a script change is painted on the first frame, not after the bundle loads', () => {
    seed({ preference: 'zh-Hans', locale: 'zh-Hans' });
    runPrePaint();
    expect(painted()).toEqual({ lang: 'zh-Hans', dir: 'ltr' });
  });

  test('a right-to-left language paints rtl before anything can lay out left-to-right', () => {
    seed({ preference: 'ar', locale: 'ar' });
    runPrePaint();
    expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });
  });

  test('a system preference paints the locale it last resolved to', () => {
    // The sentinel survives in the cache, so nothing downstream can mistake the
    // painted locale for a choice the user made.
    seed({ preference: 'system', locale: 'ur' });
    expect(JSON.parse(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY) ?? '{}').pref).toBe(
      'system',
    );

    runPrePaint();
    expect(painted()).toEqual({ lang: 'ur', dir: 'rtl' });
  });

  test('no cache at all leaves the document’s own default alone', () => {
    runPrePaint();
    expect(painted()).toEqual({ lang: null, dir: null });
  });

  test('survives corrupt cache JSON without throwing or painting', () => {
    localStorage.setItem(LANGUAGE_CACHE_STORAGE_KEY, '{not json');
    expect(() => runPrePaint()).not.toThrow();
    expect(painted()).toEqual({ lang: null, dir: null });
  });

  test('a cache holding something that is not a language tag is ignored', () => {
    // `lang` reaches CSS attribute selectors and font-family matching, so the
    // value written to it is not free-form even though only this app writes it.
    for (const locale of ['', 'not a tag', '<script>', 'e'.repeat(80), 42, null]) {
      localStorage.setItem(LANGUAGE_CACHE_STORAGE_KEY, JSON.stringify({ locale, dir: 'rtl' }));
      runPrePaint();
      expect(painted()).toEqual({ lang: null, dir: null });
    }
  });

  test('a cache with an unreadable direction still paints, left-to-right', () => {
    // Direction is the field most likely to be lost to an older build's cache,
    // and guessing `rtl` would flip the whole layout for a language that reads
    // the other way.
    localStorage.setItem(LANGUAGE_CACHE_STORAGE_KEY, JSON.stringify({ locale: 'es' }));
    runPrePaint();
    expect(painted()).toEqual({ lang: 'es', dir: 'ltr' });
  });

  test('storage being unavailable costs the head start, not the session', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('QuotaExceededError');
    };
    try {
      expect(() => applyLanguageToDom({ preference: 'ar', locale: 'ar' })).not.toThrow();
      // The running session is correct; only the next load's head start is lost.
      expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });
    } finally {
      Storage.prototype.setItem = original;
    }

    runPrePaint();
    expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });
  });
});
