
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ChunkedInsertError, HtmlPayloadTooLargeError } from '@inkeep/open-knowledge-core';

import {
  classifyError,
  logUnmappedLucideIcon,
  logWalkerUrlClassifierFailed,
  logWalkerUrlSourceEmitted,
  resetUnmappedLucideSeenForTest,
} from './instrument.ts';

describe('logUnmappedLucideIcon — once-per-process per-class dedup', () => {
  let origWarn: typeof console.warn;
  let warnings: string[];

  beforeEach(() => {
    resetUnmappedLucideSeenForTest();
    warnings = [];
    origWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnings.push(typeof msg === 'string' ? msg : String(msg));
    };
  });

  afterEach(() => {
    console.warn = origWarn;
    resetUnmappedLucideSeenForTest();
  });

  test('emits on first call for a given class', () => {
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'wysiwyg' });
    expect(warnings).toHaveLength(1);
    const event = JSON.parse(warnings[0]);
    expect(event.event).toBe('clipboard-walker-unmapped-lucide-detected');
    expect(event.view).toBe('wysiwyg');
    expect(event.lucideClass).toBe('lucide-foo');
  });

  test('suppresses repeat calls for the same class', () => {
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'wysiwyg' });
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'wysiwyg' });
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'wysiwyg' });
    expect(warnings).toHaveLength(1);
  });

  test('emits independently for distinct classes', () => {
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'wysiwyg' });
    logUnmappedLucideIcon({ lucideClass: 'lucide-bar', view: 'wysiwyg' });
    logUnmappedLucideIcon({ lucideClass: 'lucide-baz', view: 'wysiwyg' });
    expect(warnings).toHaveLength(3);
    const events = warnings.map((w) => JSON.parse(w));
    expect(events.map((e) => e.lucideClass)).toEqual(['lucide-foo', 'lucide-bar', 'lucide-baz']);
  });

  test('dedup persists across distinct view values for the same class', () => {
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'wysiwyg' });
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'source' });
    expect(warnings).toHaveLength(1);
  });

  test('emitted JSON shape carries event + view + lucideClass and nothing else', () => {
    logUnmappedLucideIcon({ lucideClass: 'lucide-foo', view: 'wysiwyg' });
    const event = JSON.parse(warnings[0]);
    expect(Object.keys(event).sort()).toEqual(['event', 'lucideClass', 'view']);
  });
});

describe('classifyError — taxonomy classifier for `errorClass` telemetry field', () => {
  test('HtmlPayloadTooLargeError instance returns its name', () => {
    const err = new HtmlPayloadTooLargeError('payload too large');
    expect(classifyError(err)).toBe('HtmlPayloadTooLargeError');
  });

  test('ChunkedInsertError instance returns its name', () => {
    const err = new ChunkedInsertError('insert failed', {
      chunksCompleted: 1,
      totalChunks: 5,
      bytesWritten: 100,
      bytesRemaining: 400,
      cause: new Error('boom'),
    });
    expect(classifyError(err)).toBe('ChunkedInsertError');
  });

  test('Error subclass with non-default `name` returns the custom name', () => {
    class FooError extends Error {
      override name = 'FooError';
    }
    expect(classifyError(new FooError('foo'))).toBe('FooError');
  });

  test('plain `new Error()` (default name === "Error") returns undefined', () => {
    expect(classifyError(new Error('boom'))).toBeUndefined();
  });

  test('non-Error thrown values return undefined', () => {
    expect(classifyError('string')).toBeUndefined();
    expect(classifyError(42)).toBeUndefined();
    expect(classifyError(null)).toBeUndefined();
    expect(classifyError(undefined)).toBeUndefined();
    expect(classifyError({ message: 'plain object' })).toBeUndefined();
  });
});

describe('logWalkerUrlSourceEmitted — source-fallback emission signal', () => {
  let origWarn: typeof console.warn;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    origWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnings.push(typeof msg === 'string' ? msg : String(msg));
    };
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  test('emits one structured JSON line per call with the four required dimensions', () => {
    logWalkerUrlSourceEmitted({
      view: 'wysiwyg',
      tag: 'img',
      class: 'mdx-inline',
      reason: 'relative',
    });
    expect(warnings).toHaveLength(1);
    const event = JSON.parse(warnings[0]);
    expect(event).toEqual({
      event: 'clipboard-walker-url-source-emitted',
      view: 'wysiwyg',
      tag: 'img',
      class: 'mdx-inline',
      reason: 'relative',
    });
  });

  test('emits independently for distinct (tag, class, reason) tuples', () => {
    logWalkerUrlSourceEmitted({
      view: 'wysiwyg',
      tag: 'img',
      class: 'mdx-component',
      reason: 'relative',
    });
    logWalkerUrlSourceEmitted({
      view: 'wysiwyg',
      tag: 'a',
      class: 'mdx-inline',
      reason: 'localhost',
    });
    logWalkerUrlSourceEmitted({
      view: 'wysiwyg',
      tag: 'video',
      class: 'mdx-component',
      reason: 'private-ip',
    });
    expect(warnings).toHaveLength(3);
    const events = warnings.map((w) => JSON.parse(w));
    expect(events.map((e) => e.tag)).toEqual(['img', 'a', 'video']);
    expect(events.map((e) => e.class)).toEqual(['mdx-component', 'mdx-inline', 'mdx-component']);
    expect(events.map((e) => e.reason)).toEqual(['relative', 'localhost', 'private-ip']);
  });

  test('emitted JSON shape carries exactly event + view + tag + class + reason', () => {
    logWalkerUrlSourceEmitted({
      view: 'wysiwyg',
      tag: 'picture',
      class: 'mdx-component',
      reason: 'other',
    });
    const event = JSON.parse(warnings[0]);
    expect(Object.keys(event).sort()).toEqual(['class', 'event', 'reason', 'tag', 'view']);
  });

  test('source view is supported (palette + future source-mode emitters)', () => {
    logWalkerUrlSourceEmitted({
      view: 'source',
      tag: 'img',
      class: 'mdx-component',
      reason: 'relative',
    });
    const event = JSON.parse(warnings[0]);
    expect(event.view).toBe('source');
  });
});

describe('logWalkerUrlClassifierFailed — classifier-throw + serializer-null signal', () => {
  let origWarn: typeof console.warn;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    origWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnings.push(typeof msg === 'string' ? msg : String(msg));
    };
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  test('emits with phase=classifier-throw + errorClass when the URL classifier throws', () => {
    logWalkerUrlClassifierFailed({
      view: 'wysiwyg',
      tag: 'img',
      phase: 'classifier-throw',
      errorClass: classifyError(new HtmlPayloadTooLargeError('boom')),
    });
    expect(warnings).toHaveLength(1);
    const event = JSON.parse(warnings[0]);
    expect(event).toEqual({
      event: 'clipboard-walker-url-classifier-failed',
      view: 'wysiwyg',
      tag: 'img',
      phase: 'classifier-throw',
      errorClass: 'HtmlPayloadTooLargeError',
    });
  });

  test('emits with phase=serializer-null and no errorClass when the markdown serializer fails', () => {
    logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag: 'img', phase: 'serializer-null' });
    const event = JSON.parse(warnings[0]);
    expect(event).toEqual({
      event: 'clipboard-walker-url-classifier-failed',
      view: 'wysiwyg',
      tag: 'img',
      phase: 'serializer-null',
    });
    expect('errorClass' in event).toBe(false);
  });

  test('omits errorClass when classifyError(err) returns undefined (default `Error` name)', () => {
    logWalkerUrlClassifierFailed({
      view: 'wysiwyg',
      tag: 'a',
      phase: 'classifier-throw',
      errorClass: classifyError(new Error('boom')),
    });
    const event = JSON.parse(warnings[0]);
    expect(event).toEqual({
      event: 'clipboard-walker-url-classifier-failed',
      view: 'wysiwyg',
      tag: 'a',
      phase: 'classifier-throw',
    });
    expect('errorClass' in event).toBe(false);
  });

  test('omits errorClass when caller passes nothing for it (non-Error throws)', () => {
    logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag: 'source', phase: 'classifier-throw' });
    const event = JSON.parse(warnings[0]);
    expect('errorClass' in event).toBe(false);
    expect(event.event).toBe('clipboard-walker-url-classifier-failed');
    expect(event.tag).toBe('source');
    expect(event.phase).toBe('classifier-throw');
  });

  test('every WalkerUrlSourceTag value is accepted by the emitter signature', () => {
    const tags = ['img', 'video', 'audio', 'source', 'a', 'picture'] as const;
    for (const tag of tags) {
      logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag, phase: 'classifier-throw' });
    }
    expect(warnings).toHaveLength(tags.length);
    const observedTags = warnings.map((w) => JSON.parse(w).tag);
    expect(observedTags).toEqual([...tags]);
  });

  test('the three phase literals are the only accepted values (operability discriminator)', () => {
    logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag: 'img', phase: 'classifier-throw' });
    logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag: 'img', phase: 'serializer-null' });
    logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag: 'img', phase: 'serializer-throw' });
    const phases = warnings.map((w) => JSON.parse(w).phase);
    expect(phases).toEqual(['classifier-throw', 'serializer-null', 'serializer-throw']);
  });
});
