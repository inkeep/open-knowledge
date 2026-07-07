import { describe, expect, test } from 'bun:test';
import {
  isDangerousPropName,
  isUrlPropName,
  sanitizeComponentProps,
  sanitizeUrlValue,
  URL_PROP_NAMES,
} from './sanitize-url';

describe('sanitizeUrlValue', () => {
  test('passes http/https through unchanged', () => {
    expect(sanitizeUrlValue('https://example.com')).toBe('https://example.com');
    expect(sanitizeUrlValue('http://example.com/a?b=c#d')).toBe('http://example.com/a?b=c#d');
  });

  test('passes mailto/tel/ftp/sms through unchanged', () => {
    expect(sanitizeUrlValue('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(sanitizeUrlValue('tel:+1-800-555-1212')).toBe('tel:+1-800-555-1212');
    expect(sanitizeUrlValue('ftp://files.example.com/x')).toBe('ftp://files.example.com/x');
    expect(sanitizeUrlValue('sms:+15551234567')).toBe('sms:+15551234567');
  });

  test('passes relative paths and fragments through', () => {
    expect(sanitizeUrlValue('/docs/foo')).toBe('/docs/foo');
    expect(sanitizeUrlValue('./sibling')).toBe('./sibling');
    expect(sanitizeUrlValue('../up')).toBe('../up');
    expect(sanitizeUrlValue('#section')).toBe('#section');
    expect(sanitizeUrlValue('path/with:colon')).toBe('path/with:colon');
    expect(sanitizeUrlValue('query?x:y=1')).toBe('query?x:y=1');
  });

  test('passes protocol-relative URLs through', () => {
    expect(sanitizeUrlValue('//cdn.example.com/lib.js')).toBe('//cdn.example.com/lib.js');
  });

  test('strips javascript: scheme', () => {
    expect(sanitizeUrlValue('javascript:alert(1)')).toBe('#');
    expect(sanitizeUrlValue('JavaScript:alert(1)')).toBe('#');
    expect(sanitizeUrlValue(' javascript:alert(1) ')).toBe('#');
  });

  test('strips vbscript: scheme', () => {
    expect(sanitizeUrlValue('vbscript:MsgBox(1)')).toBe('#');
  });

  test('strips data:text/html scheme (but other schemes still blocked too)', () => {
    expect(sanitizeUrlValue('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(sanitizeUrlValue('data:image/png;base64,XXXX')).toBe('#');
  });

  test('strips custom / uncommon schemes', () => {
    expect(sanitizeUrlValue('file:///etc/passwd')).toBe('#');
    expect(sanitizeUrlValue('chrome://settings')).toBe('#');
  });

  test('passes empty/falsy strings through', () => {
    expect(sanitizeUrlValue('')).toBe('');
    expect(sanitizeUrlValue(undefined)).toBe(undefined);
    expect(sanitizeUrlValue(null)).toBe(null);
  });

  test('passes non-strings through (caller guards key against URL_PROP_NAMES)', () => {
    expect(sanitizeUrlValue(42)).toBe(42);
    expect(sanitizeUrlValue(true)).toBe(true);
  });
});

describe('isDangerousPropName', () => {
  test('rejects dangerouslySetInnerHTML (camelCase, lowercase, kebab)', () => {
    expect(isDangerousPropName('dangerouslySetInnerHTML')).toBe(true);
    expect(isDangerousPropName('dangerouslysetinnerhtml')).toBe(true);
    expect(isDangerousPropName('DANGEROUSLYSETINNERHTML')).toBe(true);
  });

  test('rejects every on* event handler prop name', () => {
    for (const n of ['onClick', 'onMouseDown', 'onFocus', 'onerror', 'onLoad', 'ONDRAG']) {
      expect(isDangerousPropName(n)).toBe(true);
    }
  });

  test('rejects React internals', () => {
    expect(isDangerousPropName('ref')).toBe(true);
    expect(isDangerousPropName('key')).toBe(true);
    expect(isDangerousPropName('defaultValue')).toBe(true);
    expect(isDangerousPropName('defaultChecked')).toBe(true);
  });

  test('accepts regular prop names', () => {
    expect(isDangerousPropName('title')).toBe(false);
    expect(isDangerousPropName('className')).toBe(false);
    expect(isDangerousPropName('on')).toBe(false); // bare 'on' is not an event handler
    expect(isDangerousPropName('href')).toBe(false);
  });

  test('denies on*-prefix names defensively (both React camelCase and HTML lowercase)', () => {
    // Both React camelCase (onClick) and HTML lowercase (onclick) event
    // handlers are XSS gadgets. We block every on*-prefixed name ≥ 3 chars
    // rather than try to enumerate every valid event name; legitimate props
    // that happen to start with literal "on" (e.g. "one") are rejected as
    // well. None of the 17 built-in descriptors use such names, and a
    // descriptor author can rename the prop if they hit this.
    expect(isDangerousPropName('onclick')).toBe(true); // lowercase HTML form
    expect(isDangerousPropName('onfoo')).toBe(true); // unknown on* name
    expect(isDangerousPropName('one')).toBe(true); // false positive, accepted
  });
});

describe('isUrlPropName', () => {
  test('matches camelCase React form of URL attrs', () => {
    expect(isUrlPropName('formAction')).toBe(true);
    expect(isUrlPropName('xlinkHref')).toBe(true);
    expect(isUrlPropName('xlinkActuate')).toBe(true);
  });

  test('matches lowercase form', () => {
    expect(isUrlPropName('href')).toBe(true);
    expect(isUrlPropName('src')).toBe(true);
    expect(isUrlPropName('action')).toBe(true);
    expect(isUrlPropName('formaction')).toBe(true);
  });

  test('rejects non-URL props', () => {
    expect(isUrlPropName('title')).toBe(false);
    expect(isUrlPropName('className')).toBe(false);
  });
});

describe('sanitizeComponentProps — URL-scheme filtering', () => {
  test('rewrites only URL-typed props', () => {
    const input = {
      href: 'javascript:alert(1)',
      title: 'Hello',
      external: true,
      src: 'https://ok.example.com/x.png',
    };
    const output = sanitizeComponentProps(input);
    expect(output.href).toBe('#');
    expect(output.src).toBe('https://ok.example.com/x.png');
    expect(output.title).toBe('Hello');
    expect(output.external).toBe(true);
  });

  test('returns input unchanged when no URL-typed prop needs rewriting', () => {
    const input = {
      href: 'https://example.com',
      title: 'Hello',
    };
    const output = sanitizeComponentProps(input);
    expect(output).toBe(input); // same reference — no unnecessary re-render
  });

  test('covers all known URL prop names', () => {
    const allMalicious: Record<string, string> = {};
    for (const name of URL_PROP_NAMES) allMalicious[name] = 'javascript:alert(1)';
    const output = sanitizeComponentProps(allMalicious);
    for (const name of URL_PROP_NAMES) {
      expect(output[name]).toBe('#');
    }
  });

  test('filters camelCase formAction (case-insensitive match)', () => {
    const output = sanitizeComponentProps({ formAction: 'javascript:alert(1)' });
    expect(output.formAction).toBe('#');
  });

  test('filters SVG xlinkHref', () => {
    const output = sanitizeComponentProps({ xlinkHref: 'javascript:alert(1)' });
    expect(output.xlinkHref).toBe('#');
  });
});

describe('sanitizeComponentProps — dangerous prop denylist', () => {
  test('drops dangerouslySetInnerHTML entirely (XSS gadget)', () => {
    const input = {
      dangerouslySetInnerHTML: { __html: '<img src=x onerror=alert(1)>' },
      title: 'safe',
    };
    const output = sanitizeComponentProps(input);
    expect(output.dangerouslySetInnerHTML).toBeUndefined();
    expect(Object.hasOwn(output, 'dangerouslySetInnerHTML')).toBe(false);
    expect(output.title).toBe('safe');
  });

  test('drops onClick / onError / onMouseDown', () => {
    const input = {
      onClick: 'alert(1)',
      onError: () => {
        /* ignore */
      },
      onMouseDown: 'alert(2)',
      title: 'safe',
    };
    const output = sanitizeComponentProps(input);
    expect(output.onClick).toBeUndefined();
    expect(output.onError).toBeUndefined();
    expect(output.onMouseDown).toBeUndefined();
    expect(output.title).toBe('safe');
  });

  test('drops React internals (ref/key/defaultValue)', () => {
    const output = sanitizeComponentProps({
      ref: { current: null },
      key: 'stable-id',
      defaultValue: 'seed',
      title: 'safe',
    });
    expect(Object.hasOwn(output, 'ref')).toBe(false);
    expect(Object.hasOwn(output, 'key')).toBe(false);
    expect(Object.hasOwn(output, 'defaultValue')).toBe(false);
    expect(output.title).toBe('safe');
  });

  test('accepts props whose names start with "on" but are not event handlers', () => {
    // 2-char names don't match the on* guard (requires length >= 3).
    const output = sanitizeComponentProps({ on: true, title: 'safe' });
    expect(output.on).toBe(true);
    expect(output.title).toBe('safe');
  });
});

describe('sanitizeComponentProps — style handling', () => {
  test('passes safe style strings through', () => {
    const output = sanitizeComponentProps({ style: 'color: red; padding: 4px' });
    expect(output.style).toBe('color: red; padding: 4px');
  });

  test('drops style string with javascript: url()', () => {
    const output = sanitizeComponentProps({
      style: 'background: url(javascript:alert(1))',
    });
    expect(output.style).toBe('');
  });

  test('drops style string with expression() (legacy IE gadget)', () => {
    const output = sanitizeComponentProps({
      style: 'width: expression(alert(1))',
    });
    expect(output.style).toBe('');
  });

  test('drops object / non-string style values', () => {
    const output = sanitizeComponentProps({
      style: { background: 'url(javascript:alert(1))' },
    });
    expect(Object.hasOwn(output, 'style')).toBe(false);
  });
});

describe('sanitizeComponentProps — nested URL traversal', () => {
  test('sanitizes URLs inside nested array of objects (InlineTOC.items shape)', () => {
    const input = {
      items: [
        { url: 'javascript:alert(1)', title: 'bad' },
        { url: 'https://ok.example.com', title: 'good' },
      ],
    };
    const output = sanitizeComponentProps(input) as {
      items: Array<{ url: string; title: string }>;
    };
    expect(output.items[0].url).toBe('#');
    expect(output.items[1].url).toBe('https://ok.example.com');
  });

  test('sanitizes URLs inside nested object', () => {
    const input = {
      meta: { href: 'vbscript:alert(1)', label: 'x' },
    };
    const output = sanitizeComponentProps(input) as {
      meta: { href: string; label: string };
    };
    expect(output.meta.href).toBe('#');
    expect(output.meta.label).toBe('x');
  });

  test('drops dangerous prop names inside nested object (Mi3 review fix)', () => {
    // The top-level filter dropped `dangerouslySetInnerHTML` / `on*`; the
    // nested traversal previously passed them through. A future descriptor
    // that spreads nested attrs onto a React element would have smuggled
    // them past sanitization. The fix mirrors the top-level filter at
    // depth.
    const input = {
      items: [
        {
          label: 'safe',
          // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising the dangerous-name path
          onClick: 'alert(1)' as any,
          dangerouslySetInnerHTML: { __html: '<script>x</script>' },
        },
      ],
    };
    const output = sanitizeComponentProps(input) as {
      items: Array<Record<string, unknown>>;
    };
    expect(output.items[0]).toBeDefined();
    expect(Object.hasOwn(output.items[0], 'label')).toBe(true);
    expect(output.items[0].label).toBe('safe');
    expect(Object.hasOwn(output.items[0], 'onClick')).toBe(false);
    expect(Object.hasOwn(output.items[0], 'dangerouslySetInnerHTML')).toBe(false);
  });

  test('sanitizes URL at depth 6 (no recursion cap)', () => {
    // Earlier revisions capped recursion at depth 4 and fail-opened nested
    // URLs past that depth — letting `{a:{b:{c:{d:{e:{url:'javascript:…'}}}}}}`
    // through unchanged. The cap was over-cautious (MDX expression-attrs are
    // text-parsed and acyclic); recursion is now unbounded and this attack
    // class is closed.
    const deep = { a: { b: { c: { d: { e: { url: 'javascript:alert(1)' } } } } } };
    const output = sanitizeComponentProps(deep) as typeof deep;
    expect(output.a.b.c.d.e.url).toBe('#');
  });

  test('sanitizes URL at depth 8 inside arrays-of-objects', () => {
    // Deep + array-mixed shape. Verifies the recursion descends through
    // both object and array branches without depth limit.
    const deep = {
      sections: [
        {
          rows: [
            {
              cells: [
                {
                  meta: { href: 'vbscript:msgbox' },
                },
              ],
            },
          ],
        },
      ],
    };
    const output = sanitizeComponentProps(deep) as typeof deep;
    expect(output.sections[0].rows[0].cells[0].meta.href).toBe('#');
  });
});
