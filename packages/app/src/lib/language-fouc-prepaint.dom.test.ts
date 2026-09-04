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

function seed(input: ApplyLanguageInput): void {
  applyLanguageToDom(input);
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
    for (const locale of ['', 'not a tag', '<script>', 'e'.repeat(80), 42, null]) {
      localStorage.setItem(LANGUAGE_CACHE_STORAGE_KEY, JSON.stringify({ locale, dir: 'rtl' }));
      runPrePaint();
      expect(painted()).toEqual({ lang: null, dir: null });
    }
  });

  test('a cache with an unreadable direction still paints, left-to-right', () => {
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
      expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });
    } finally {
      Storage.prototype.setItem = original;
    }

    runPrePaint();
    expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });
  });
});
