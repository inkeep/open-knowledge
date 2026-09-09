/**
 * Agent writes are byte-faithful (precedent #38, Y.Text-is-truth): the bytes the agent submits land
 * in `Y.Text('source')` verbatim.
 */

import type { ServerResponse } from 'node:http';
import { stripDocExtension } from './doc-extensions.ts';
import { errorResponse } from './http/error-response.ts';

const FIX_HINT =
  'Frontmatter must be a top-level YAML mapping. Quote string values containing YAML-significant characters (`:`, `#`, leading `-`), e.g. `title: "Foo: bar"`.';

export class FrontmatterMalformedError extends Error {
  readonly file: string;
  readonly parseError: string;
  readonly refusalClass?: FrontmatterMalformedClass;
  readonly hint?: string;
  override readonly name = 'FrontmatterMalformedError' as const;

  constructor(opts: {
    file: string;
    parseError: string;
    refusalClass?: FrontmatterMalformedClass;
    hint?: string;
  }) {
    super(`Frontmatter YAML is malformed in ${opts.file}: ${opts.parseError}`);
    this.file = opts.file;
    this.parseError = opts.parseError;
    if (opts.refusalClass !== undefined) this.refusalClass = opts.refusalClass;
    if (opts.hint !== undefined) this.hint = opts.hint;
  }
}

export type FrontmatterMalformedClass =
  | 'yaml-parse-error'
  | 'non-mapping-top-level'
  | 'schema-rejection'
  | 'byte-0-promotion'
  | 'unknown';

export function classifyParseError(parseError: string): FrontmatterMalformedClass {
  if (parseError === 'top-level value is not a mapping') return 'non-mapping-top-level';
  if (parseError.startsWith('value at "') || parseError.startsWith('schema validation failed:')) {
    return 'schema-rejection';
  }
  if (parseError.startsWith('parse threw:') || parseError.startsWith('toJS threw:')) {
    return 'yaml-parse-error';
  }
  if (parseError.length > 0 && parseError !== 'unknown YAML parse error') {
    return 'yaml-parse-error';
  }
  return 'unknown';
}

function frontmatterRefusalClass(err: FrontmatterMalformedError): FrontmatterMalformedClass {
  return err.refusalClass ?? classifyParseError(err.parseError);
}

export function frontmatterRefusalDetail(err: FrontmatterMalformedError): string {
  return `${err.parseError}. ${err.hint ?? FIX_HINT}`;
}

export function logFrontmatterRefusal(err: FrontmatterMalformedError, handler: string): void {
  console.warn(
    JSON.stringify({
      event: 'frontmatter-malformed-write-refused',
      handler,
      class: frontmatterRefusalClass(err),
      'doc.name': stripDocExtension(err.file),
      parseError: err.parseError,
    }),
  );
}

export function respondFrontmatterMalformed(
  res: ServerResponse,
  err: FrontmatterMalformedError,
  handler: string,
): void {
  logFrontmatterRefusal(err, handler);
  errorResponse(res, 400, 'urn:ok:error:frontmatter-malformed', 'Frontmatter YAML is malformed.', {
    handler,
    detail: frontmatterRefusalDetail(err),
    extensions: {
      file: err.file,
      parseError: err.parseError,
    },
  });
}
