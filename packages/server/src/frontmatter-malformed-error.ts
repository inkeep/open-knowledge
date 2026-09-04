/**
 * Malformed-frontmatter write refusal: typed error + RFC 9457 envelope helper.
 *
 * Agent writes are byte-faithful (precedent #38, Y.Text-is-truth): the bytes
 * the agent submits land in `Y.Text('source')` verbatim. That's load-bearing
 * for source-form preservation, but it means a payload whose YAML region is
 * unparseable also lands on disk verbatim — the property panel then renders
 * the "Frontmatter YAML is malformed" banner and the file's own keys are
 * unrecoverable without a hand-edit. The most common shape: a
 * string value containing an unquoted YAML-significant character (`:`, `#`,
 * leading `-`), e.g. `title: The End of 3% Mortgages: Why ...`.
 *
 * The gate lives at `applyAgentMarkdownWriteInner` and fires when the agent's
 * write actually CHANGES the FM region (`finalFm !== existingFm`). Existing
 * docs that already carry malformed FM on disk continue to accept body-only
 * writes — the rejection is targeted at the introducer, not the inheritor.
 *
 * A second arm catches the same outcome by a different route: an append or
 * prepend inherits `existingFm` by construction, so it can never trip the
 * first arm, but it CAN place a `---`-fenced non-mapping span at byte 0 of a
 * document that has no frontmatter. The composed bytes then re-partition and
 * that span becomes the FM region — malformed frontmatter the agent never
 * asked for. Same envelope, but it carries its own `refusalClass`
 * (`byte-0-promotion`) and `hint`: nothing was parsed, so the YAML-quoting
 * advice would misdirect, and counting it as a parse error would blunt the
 * one signal the class label exists to give.
 *
 * Wire shape — slim RFC 9457 envelope at HTTP 400:
 *
 *   {
 *     "type": "urn:ok:error:frontmatter-malformed",
 *     "title": "Frontmatter YAML is malformed.",
 *     "status": 400,
 *     "detail": "<parser message>. Common cause: a string value contains an
 *                unquoted YAML-significant character (`:`, `#`, leading `-`).
 *                Quote the value, e.g. `title: \"Foo: bar\"`.",
 *     "file": "<.md path>",
 *     "parseError": "<raw yaml@2 parser message>"
 *   }
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
