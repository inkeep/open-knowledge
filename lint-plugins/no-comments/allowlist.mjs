import { citedPrecedentNumbers } from './precedents.mjs';
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

export const DIRECTIVE_PATTERNS = [
  { id: 'biome-ignore', target: 'headline', regex: /^biome-ignore(?:-all|-start|-end)?\s+\S+\s*:\s*\S/ },
  { id: 'oxlint-disable', target: 'headline', regex: /^oxlint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  { id: 'eslint-disable', target: 'headline', regex: /^eslint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  { id: 'vite-ignore', target: 'headline', regex: /^@vite-ignore\b/ },
  { id: 'prettier-ignore', target: 'headline', regex: /^prettier-ignore\b/ },
  { id: 'triple-slash-reference', target: 'text', regex: /^\/\/\/\s*<reference\b/ },
  { id: 'vitest-environment', target: 'headline', regex: /^@vitest-environment\s+\S/ },
  { id: 'ts-nocheck', target: 'headline', regex: /^@ts-nocheck\b/ },
  { id: 'ts-check', target: 'headline', regex: /^@ts-check\b/ },
  {
    id: 'license-header',
    target: 'text',
    regex: /SPDX-License-Identifier:|@license\b/,
  },
  { id: 'pure-annotation', target: 'headline', regex: /^[@#]__PURE__/ },
  { id: 'no-side-effects-annotation', target: 'headline', regex: /^[@#]__NO_SIDE_EFFECTS__\s*$/ },
  { id: 'preserve', target: 'headline', regex: /^@preserve\b/ },
  { id: 'jsx-pragma', target: 'headline', regex: /^@jsx(?:Frag|Runtime|ImportSource)?\s+\S+\s*$/ },
  {
    id: 'webpack-magic',
    target: 'headline',
    regex:
      /^webpack(?:ChunkName|Ignore|Include|Exclude|Mode|Prefetch|Preload|Exports|FetchPriority)\s*:/,
  },
  {
    id: 'source-map-pragma',
    target: 'text',
    regex: /^\/\/[#@][ \t]*source(?:MappingURL|URL)=\S+$/,
  },
  { id: 'coverage-ignore', target: 'headline', regex: /^(?:v8|c8|istanbul|node-coverage) ignore\b/ },
  {
    id: 'knip-lintignore',
    target: 'text',
    regex: LINTIGNORE_WITH_REASON_RE,
  },
];

const TS_EXPECT_ERROR_RE = /^@ts-expect-error\s*(.*)$/;
const TS_IGNORE_RE = /@ts-ignore\b/;

export const UPSTREAM_REFERENT_SHAPES = [
  { id: 'github-issue', regex: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+$/ },
  { id: 'rfc', regex: /^RFC \d+(?: §[\w.§-]+)?$/ },
  { id: 'commonmark', regex: /^CommonMark §[\w.§-]+$/ },
  { id: 'package-version', regex: /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?@\d[\w.+-]*$/i },
];

export const GUARD_MARKERS = [
  { id: 'precedent-30-exemption', regex: /documented exemption from Precedent #30/i },
  { id: 'error-log-shape-ok', regex: /\berror-log-shape-ok:\s*\S/ },
  { id: 'presence-exempt', regex: /\bpresence-exempt:\s*\S/ },
];

const UPSTREAM_PREFIX_RE = /^UPSTREAM\(([^)]*)\):/;
const CONTRACT_PREFIX_RE = /^(STOP|WARN):\s*\S/;

export function commentBodyLines(text) {
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

export function classifyComment(comment, options = {}) {
  const {
    precedentNumbers,
    jsdocTypes = false,
    sanctionedTags = SANCTIONED_TAGS,
  } = options;
  const text = comment.text;
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

  for (const directive of DIRECTIVE_PATTERNS) {
    const subject = directive.target === 'headline' ? headline : text;
    if (directive.regex.test(subject)) return withRotScan(allowed('directive', directive.id), text);
  }

  for (const tag of sanctionedTags) {
    if (tagOnOwnLine(text, tag)) return withRotScan(allowed('sanctioned-tag', tag), text);
  }

  if (DEPRECATED_TAG_LINE_RE.test(text)) return withRotScan(allowed('deprecated', '@deprecated'), text);

  if (CONTRACT_PREFIX_RE.test(headline)) {
    return withRotScan(allowed('contract-marker', headline.slice(0, headline.indexOf(':'))), text);
  }

  const upstream = UPSTREAM_PREFIX_RE.exec(headline);
  if (upstream) {
    const referent = upstream[1].trim();
    const shape = UPSTREAM_REFERENT_SHAPES.find((candidate) => candidate.regex.test(referent));
    if (!shape) {
      return violation(
        'invalid-upstream-referent',
        'The parenthesized referent must be shape-valid; supporting links belong in the marker body. Use a resolvable referent: `owner/repo#N`, `RFC <n>`, `CommonMark §<n>`, or `pkg@<version>`.',
        `UPSTREAM referent "${referent}" matches no accepted shape`,
      );
    }
    return withRotScan(allowed('contract-marker', `UPSTREAM/${shape.id}`), text);
  }

  for (const marker of GUARD_MARKERS) {
    if (marker.regex.test(text)) return withRotScan(allowed('guard-marker', marker.id), text);
  }

  const cited = citedPrecedentNumbers(text);
  if (cited.length > 0) {
    if (!(precedentNumbers instanceof Set)) {
      throw new TypeError(
        'classifyComment needs a precedentNumbers Set to judge a precedent citation; ' +
          'load one with loadPrecedentNumbers(repoRoot).',
      );
    }
    const unknown = cited.filter((number) => !precedentNumbers.has(number));
    if (unknown.length > 0) {
      return violation(
        'invalid-precedent',
        'Cite a precedent that exists in PRECEDENTS.md, or drop the citation.',
        `precedent #${unknown[0]} is not a numbered slot in PRECEDENTS.md`,
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
