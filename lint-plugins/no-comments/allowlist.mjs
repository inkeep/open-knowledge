import { citedPrecedentNumbers, PrecedentRegistry } from './precedents.mjs';
import { findRotMatches } from './rot.mjs';

export const SANCTIONED_TAGS = [];

export const DOCS_URL_BASE =
  'https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/no-comments/README.md';

const LINTIGNORE_RE = /(?:^|\n)[^\S\n]*(?:\/\*+|\*+)?[^\S\n]*@lintignore\b/;
const LINTIGNORE_WITH_REASON_RE =
  /(?:^|\n)[^\S\n]*(?:\/\*+|\*+)?[^\S\n]*@lintignore[^\S\n]+(?!\*\/)\S/;

const TAG_LINE_PREFIX = '(?:^|\\n)[^\\S\\n]*(?:\\/\\/+|\\/\\*+|\\*+)?[^\\S\\n]*';
const DEPRECATED_TAG_LINE_RE = new RegExp(`${TAG_LINE_PREFIX}@deprecated\\b`);
const JSDOC_TYPE_LINE_RE =
  /^@(?:type|typedef|param|returns?|template|satisfies|callback|property|prop|this|enum)\b(?:[^{}]*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})?[ \t]*[\w$[\]().'"@/|<>,=-]*[ \t]*$/;
const JSDOC_IMPORT_LINE_RE = /^@import[ \t]+\{[^}]*\}[ \t]+from[ \t]+['"][^'"]+['"];?$/;

function isJsdocTypeComment(text) {
  if (!text.startsWith('/**')) return false;
  const lines = commentBodyLines(text).filter((line) => line.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every(
    (line) => JSDOC_TYPE_LINE_RE.test(line.trim()) || JSDOC_IMPORT_LINE_RE.test(line.trim()),
  );
}

const TAG_LINE_RE_CACHE = new Map();

function tagOnOwnLine(text, tag) {
  let re = TAG_LINE_RE_CACHE.get(tag);
  if (!re) {
    re = new RegExp(`${TAG_LINE_PREFIX}${tag}(?![\\w-])`);
    TAG_LINE_RE_CACHE.set(tag, re);
  }
  return re.test(text);
}

const TSC = { kind: 'declared', package: 'typescript', invokedBy: 'typecheck' };
const ROLLDOWN = { kind: 'transitive', package: 'rolldown', via: 'tsdown', invokedBy: 'build' };
const OXLINT = { kind: 'declared', package: 'oxlint', invokedBy: 'lint' };

export const OPENING_LINE_WINDOW = 3;

export const DIRECTIVE_PATTERNS = [
  {
    id: 'biome-ignore',
    target: 'headline',
    regex: /^biome-ignore(?:-all|-start|-end)?\s+\S+\s*:\s*\S/,
    shapes: ['biome-ignore {rule}: {reason}'],
    consumer: { kind: 'declared', package: '@biomejs/biome', invokedBy: 'lint' },
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'oxlint-disable',
    target: 'headline',
    regex: /^oxlint-(?:disable|enable)(?:-next-line|-line)?\b/,
    shapes: ['oxlint-disable', 'oxlint-enable', 'oxlint-disable-next-line', 'oxlint-disable-line'],
    consumer: OXLINT,
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'eslint-disable',
    target: 'headline',
    regex: /^eslint-(?:disable|enable)(?:-next-line|-line)?\b/,
    shapes: ['eslint-disable', 'eslint-enable', 'eslint-disable-next-line', 'eslint-disable-line'],
    consumer: OXLINT,
    reach: {
      verdict: 'reached',
      note: 'oxlint core honours the eslint grammar; no ESLint is installed and none is needed.',
    },
  },
  {
    id: 'vite-ignore',
    target: 'headline',
    regex: /^@vite-ignore\b/,
    shapes: ['@vite-ignore'],
    consumer: ROLLDOWN,
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'triple-slash-reference',
    target: 'text',
    regex: /^\/\/\/\s*<reference\b/,
    shapes: ['/// <reference types="x" />'],
    consumer: TSC,
    reach: {
      verdict: 'unreached',
      note:
        'The canonical host is a .d.ts, which scope excludes. tsc reads the directive in any .ts, ' +
        'so the reach failure is an encoded judgment about where the shape occurs rather than a ' +
        'derived fact, and the entry stays.',
    },
  },
  {
    id: 'vitest-environment',
    target: 'headline',
    regex: /^@vitest-environment\s+\S/,
    shapes: ['@vitest-environment {env}'],
    consumer: { kind: 'declared', package: 'vitest', invokedBy: 'test' },
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'ts-nocheck',
    target: 'headline',
    regex: /^@ts-nocheck\b/,
    shapes: ['@ts-nocheck'],
    consumer: TSC,
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'ts-check',
    target: 'headline',
    regex: /^@ts-check\b/,
    shapes: ['@ts-check'],
    consumer: TSC,
    reach: {
      verdict: 'unreached',
      note:
        'No tsconfig sets checkJs, so the opt-in has nothing to opt into today. It is the sibling ' +
        'of the live @ts-nocheck, and the asymmetry between admitting one and banning the other ' +
        'is what the admission rule was written to settle.',
    },
  },
  {
    id: 'license-header',
    target: 'opening-lines',
    regex:
      /^(?:SPDX-License-Identifier:[ \t]*\(*[A-Za-z0-9.-]+(?::[A-Za-z0-9.-]+)?\+?\)*(?:[ \t]+(?:AND|OR|WITH)[ \t]+\(*[A-Za-z0-9.-]+(?::[A-Za-z0-9.-]+)?\+?\)*)*[ \t]*|@license\b.*)$/m,
    shapes: ['SPDX-License-Identifier: {expression}', '@license {terms}'],
    consumer: {
      kind: 'external',
      consumer: 'SPDX tooling and copyright law',
      admittedOn:
        'Dropping a real licence notice is a legal harm no in-repo tool can undo, and the asymmetry ' +
        'against keeping a false positive is total.',
    },
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'legal-comment',
    target: 'opener',
    regex: /^\/(?:\*|\/)!/,
    shapes: ['//! {banner}', '/*! {banner} */'],
    consumer: ROLLDOWN,
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'pure-annotation',
    target: 'headline',
    regex: /^[@#]__PURE__/,
    shapes: ['@__PURE__', '#__PURE__'],
    consumer: ROLLDOWN,
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'no-side-effects-annotation',
    target: 'headline',
    regex: /^[@#]__NO_SIDE_EFFECTS__\s*$/,
    shapes: ['@__NO_SIDE_EFFECTS__', '#__NO_SIDE_EFFECTS__'],
    consumer: ROLLDOWN,
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'preserve',
    target: 'headline',
    regex: /^@preserve\b/,
    shapes: ['@preserve'],
    consumer: ROLLDOWN,
    reach: { verdict: 'reached', note: '' },
  },
  {
    id: 'jsx-pragma',
    target: 'headline',
    regex: /^@jsx(?:Runtime|ImportSource)\s+\S+\s*$/,
    shapes: ['@jsxRuntime {runtime}', '@jsxImportSource {source}'],
    consumer: TSC,
    reach: {
      verdict: 'reached',
      note:
        'The classic-runtime pair @jsx and @jsxFrag is gone: every tsconfig here compiles with the ' +
        'automatic runtime, under which the factory pragmas cannot apply.',
    },
  },
  {
    id: 'bundler-ignore',
    target: 'headline',
    regex: /^(?:webpackIgnore|turbopackIgnore|turbopackOptional)\s*:\s*true\s*$/,
    shapes: ['webpackIgnore: true', 'turbopackIgnore: true', 'turbopackOptional: true'],
    consumer: { kind: 'declared', package: 'next', invokedBy: 'build' },
    reach: {
      verdict: 'reached',
      note:
        'Turbopack honours all three on the version this repo builds with, and rejects both a ' +
        'wrong value and a wrong key, so the value is part of the shape. The eight non-Ignore ' +
        'webpack keys buy nothing here and are gone.',
    },
  },
  {
    id: 'coverage-ignore',
    target: 'headline',
    regex: /^(?:v8|c8|istanbul) ignore\b/,
    shapes: ['v8 ignore {what}', 'c8 ignore {what}', 'istanbul ignore {what}'],
    consumer: {
      kind: 'latent',
      packages: ['@vitest/coverage-v8', '@vitest/coverage-istanbul', 'c8', 'nyc'],
      activatesWhen: 'a workspace declares one of those packages and wires a coverage run',
    },
    reach: {
      verdict: 'latent',
      note:
        'Reachability cannot be asserted here, because there is no consumer to reach. The bar is ' +
        'inverted instead: the named packages must all be absent, so wiring one in reddens this ' +
        'row and forces it to be promoted to a claim someone recorded a reason for.',
    },
  },
  {
    id: 'knip-lintignore',
    target: 'block-headline',
    regex: /^@lintignore[ \t]+(?!\*\/)\S/,
    shapes: ['/** @lintignore {reason} */'],
    consumer: { kind: 'declared', package: 'knip', invokedBy: 'knip' },
    reach: { verdict: 'reached', note: '' },
  },
];

const DIRECTIVE_REGISTRIES = {
  'c-family': { typescript: DIRECTIVE_PATTERNS, 'esm-script': DIRECTIVE_PATTERNS },
  'hash-family': { shell: [], yaml: [], python: [] },
};

export const DIRECTIVE_REGISTRY_KEYS = Object.entries(DIRECTIVE_REGISTRIES).flatMap(
  ([extractor, fileClasses]) =>
    Object.keys(fileClasses).map((fileClass) => ({ extractor, fileClass })),
);

export function directivesFor(extractor, fileClass) {
  const registry = DIRECTIVE_REGISTRIES[extractor]?.[fileClass];
  if (registry === undefined) {
    throw new Error(
      `no directive registry is declared for ${extractor} x ${fileClass}. A file class admits the ` +
        'shapes its own tools parse, so an undeclared one has no answer to give; declare it, ' +
        'empty if this repository runs nothing that reads a directive there.',
    );
  }
  return registry;
}

function openingLines(text) {
  const lines = [];
  for (const line of commentBodyLines(text)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    lines.push(trimmed);
    if (lines.length === OPENING_LINE_WINDOW) break;
  }
  return lines.join('\n');
}

const DIRECTIVE_SUBJECTS = {
  __proto__: null,
  headline: (headline) => headline,
  'block-headline': (headline, text) => (text.startsWith('/*') ? headline : null),
  'opening-lines': (_headline, text) => openingLines(text),
  opener: (_headline, text) => text,
  text: (_headline, text) => text,
};

function directiveSubject(target, headline, text) {
  const subject = DIRECTIVE_SUBJECTS[target];
  if (subject === undefined) {
    throw new Error(
      `no comment subject is declared for the directive target ${JSON.stringify(target)}. A ` +
        'target names the slice of a comment a shape is anchored to, so an undeclared one has no ' +
        'answer to give; declare it in DIRECTIVE_SUBJECTS beside the others rather than falling ' +
        'back to the whole comment, which silently widens every shape that names it.',
    );
  }
  return subject(headline, text);
}

const TS_EXPECT_ERROR_RE = /^@ts-expect-error\s*(.*)$/;
const TS_IGNORE_RE = /@ts-ignore\b/;

export const UPSTREAM_REFERENT_SHAPES = [
  { id: 'github-issue', regex: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+$/ },
  { id: 'rfc', regex: /^RFC \d+(?: §[\w.§-]+)?$/ },
  { id: 'commonmark', regex: /^CommonMark §[\w.§-]+$/ },
  {
    id: 'package-version',
    regex: /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?@\d[\w.+-]*$/i,
  },
];

const TRACKER_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)\/?$/;

export function parseUpstreamReferent(referent) {
  return referent.split(',').map((part) => {
    const raw = part.trim();
    const url = TRACKER_URL_RE.exec(raw);
    const resolved = url ? `${url[1]}/${url[2]}#${url[3]}` : raw;
    const shape = UPSTREAM_REFERENT_SHAPES.find((candidate) => candidate.regex.test(resolved));
    return { raw, referent: resolved, shape: shape?.id ?? null };
  });
}

export const GUARD_MARKERS = [
  { id: 'precedent-30-exemption', regex: /documented exemption from Precedent #30/i },
  { id: 'error-log-shape-ok', regex: /\berror-log-shape-ok:\s*\S/ },
  { id: 'presence-exempt', regex: /\bpresence-exempt:\s*\S/ },
  { id: 'defect-class', regex: /\bDefect class:\s*\S/ },
  { id: 'tolerated-call-site', regex: /\bTOLERATED:\s*\S/ },
];

const GUARD_MARKER_TARGET = 'opening-lines';

const UPSTREAM_PREFIX_RE = /^UPSTREAM\(([^)]*)\):/;
const CONTRACT_PREFIX_RE = /^(STOP|WARN):\s*\S/;

const HASH_BODY_LINE_RE = /^\s*#\s?/;

export function commentBodyLines(text) {
  if (text.startsWith('#')) {
    return text.split('\n').map((line) => line.replace(HASH_BODY_LINE_RE, '').trimEnd());
  }
  let body = text;
  if (body.startsWith('/*')) {
    body = body.slice(body.startsWith('/**') ? 3 : 2);
    if (body.endsWith('*/')) body = body.slice(0, -2);
  } else if (body.startsWith('///')) {
    body = body.slice(3);
  } else if (body.startsWith('//')) {
    body = body.slice(2);
  }
  return body.split('\n').map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd());
}

export function classificationText(text) {
  return text.includes('\r') ? text.replaceAll('\r', '') : text;
}

export function commentHeadline(text) {
  for (const line of commentBodyLines(text)) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

function violation(className, fix, detail) {
  return {
    allowed: false,
    class: className,
    fix,
    detail,
    docsUrl: `${DOCS_URL_BASE}#${className}`,
  };
}

function allowed(className, detail) {
  return { allowed: true, class: className, detail };
}

function withRotScan(verdict, text) {
  const hits = findRotMatches(text);
  if (hits.length === 0) return verdict;
  const tokens = hits.map((hit) => `"${hit.token}" (${hit.id})`).join(', ');
  return violation(
    'rot-in-survivor',
    hits.map((hit) => hit.fix).join(' '),
    `${verdict.class} comment carries the rot token${hits.length > 1 ? 's' : ''} ${tokens}`,
  );
}

export function isMarkerHead(text) {
  const headline = commentHeadline(classificationText(text));
  return CONTRACT_PREFIX_RE.test(headline) || UPSTREAM_PREFIX_RE.test(headline);
}

export function classifyComment(comment, options = {}) {
  const {
    precedentRegistry,
    jsdocTypes = false,
    sanctionedTags = SANCTIONED_TAGS,
    directives = DIRECTIVE_PATTERNS,
  } = options;
  const text = classificationText(comment.text);
  const headline = commentHeadline(text);

  if (TS_IGNORE_RE.test(text)) {
    return violation(
      'banned-directive',
      'Use `@ts-expect-error <reason>` — it fails when the underlying error disappears.',
      '@ts-ignore is banned; it silently outlives the error it suppresses',
    );
  }

  if (LINTIGNORE_RE.test(text) && !LINTIGNORE_WITH_REASON_RE.test(text)) {
    return violation(
      'unreasoned-directive',
      'Append the reason inline: `@lintignore <why knip cannot see the consumer>`.',
      '@lintignore without a reason',
    );
  }

  const expectError = TS_EXPECT_ERROR_RE.exec(headline);
  if (expectError) {
    const reason = expectError[1].replace(/\*\/\s*$/, '').trim();
    if (reason === '') {
      return violation(
        'unreasoned-directive',
        'Append the reason inline: `@ts-expect-error <why the error is expected>`.',
        '@ts-expect-error without a reason',
      );
    }
    return withRotScan(allowed('directive', '@ts-expect-error'), text);
  }

  for (const directive of directives) {
    const subject = directiveSubject(directive.target, headline, text);
    if (subject !== null && directive.regex.test(subject)) {
      return withRotScan(allowed('directive', directive.id), text);
    }
  }

  for (const tag of sanctionedTags) {
    if (tagOnOwnLine(text, tag)) return withRotScan(allowed('sanctioned-tag', tag), text);
  }

  if (DEPRECATED_TAG_LINE_RE.test(text))
    return withRotScan(allowed('deprecated', '@deprecated'), text);

  if (CONTRACT_PREFIX_RE.test(headline)) {
    return withRotScan(allowed('contract-marker', headline.slice(0, headline.indexOf(':'))), text);
  }

  const upstream = UPSTREAM_PREFIX_RE.exec(headline);
  if (upstream) {
    const parts = parseUpstreamReferent(upstream[1]);
    const unresolved = parts.filter((part) => part.shape === null);
    if (unresolved.length > 0) {
      return violation(
        'invalid-upstream-referent',
        'Every parenthesized referent must be shape-valid; supporting links belong in the marker body. Use a resolvable referent: `owner/repo#N`, a github.com issue or pull URL, `RFC <n>`, `CommonMark §<n>`, or `pkg@<version>`. Separate several with commas.',
        `UPSTREAM referent ${unresolved.map((part) => `"${part.raw}"`).join(', ')} matches no accepted shape`,
      );
    }
    return withRotScan(
      allowed('contract-marker', `UPSTREAM/${parts.map((part) => part.shape).join('+')}`),
      text,
    );
  }

  const guardSubject = directiveSubject(GUARD_MARKER_TARGET, headline, text);
  for (const marker of GUARD_MARKERS) {
    if (marker.regex.test(guardSubject))
      return withRotScan(allowed('guard-marker', marker.id), text);
  }

  const cited = citedPrecedentNumbers(text);
  if (cited.length > 0) {
    if (!(precedentRegistry instanceof PrecedentRegistry)) {
      throw new TypeError(
        'classifyComment needs a PrecedentRegistry to judge a precedent citation; load one ' +
          'with loadPrecedentRegistry(repoRoot).',
      );
    }
    const unknown = cited.filter((number) => !precedentRegistry.has(number));
    if (unknown.length > 0) {
      return violation(
        'invalid-precedent',
        'Cite a precedent that exists in PRECEDENTS.md, or drop the citation.',
        `precedent #${unknown[0]} is not a numbered slot in PRECEDENTS.md`,
      );
    }
    const retracted = cited.filter((number) => precedentRegistry.isRetracted(number));
    if (retracted.length > 0) {
      return violation(
        'retracted-precedent',
        'Cite the entry that superseded it, or state the constraint without a citation.',
        `precedent #${retracted[0]} is a retracted slot; it keeps its number for citation ` +
          'stability, but its rule no longer holds',
      );
    }
    return withRotScan(allowed('precedent-citation', `precedent #${cited[0]}`), text);
  }

  if (jsdocTypes && isJsdocTypeComment(text)) {
    return withRotScan(allowed('jsdoc-type', 'type annotation'), text);
  }

  return violation(
    'prose',
    'Delete it. Put the reasoning in the commit message, the PR body, AGENTS.md, or the spec.',
    'comment matches no allowlist class',
  );
}
