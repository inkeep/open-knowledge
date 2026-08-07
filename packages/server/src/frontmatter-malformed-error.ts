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

// Covers the failure classes that `parseFrontmatterYaml` collapses into
// `map: null`: yaml@2 parse errors (most common — unquoted
// colon class), non-mapping top-level values, and residual
// `FrontmatterMapSchema` rejections (e.g. Symbol/function values). Obsidian's
// empty-list / bare-key `null` shapes are coerced to empty values at the read
// boundary, so they no longer reach this refusal path. The hint focuses on
// the most common failure (unquoted YAML-
// significant characters) since nested mappings + arrays of objects are
// accepted by the recursive value schema. The YAML parser's raw line/column
// message also rides on the envelope's `parseError` extension so the agent
// can branch on the prefix (`value at "…" failed schema:` / `top-level
// value is not a mapping` / yaml@2's free-form line/col text).
const FIX_HINT =
  'Frontmatter must be a top-level YAML mapping. Quote string values containing YAML-significant characters (`:`, `#`, leading `-`), e.g. `title: "Foo: bar"`.';

/**
 * Typed throw from `applyAgentMarkdownWriteInner` when the agent's write is
 * the cause of a malformed FM region — either because the COMPOSED
 * frontmatter it introduces is unparseable (`finalFm !== existingFm`), or
 * because an append/prepend would promote body bytes into the FM region at
 * byte 0. The `file` field carries the doc path so the HTTP boundary can
 * surface it as the `file` extension on the RFC 9457 envelope. `parseError`
 * is the raw `yaml@2` parser message for the first case — useful for agents
 * to diagnose the offending line/column without round-tripping — and a
 * placement description for the second.
 *
 * Throw shape rather than return-value branching: this matches the same
 * uniform error-composition contract as `DocInConflictError` — every write
 * surface returns a different success shape, but throws compose uniformly
 * and catch at the HTTP boundary in one place per handler.
 */
export class FrontmatterMalformedError extends Error {
  readonly file: string;
  readonly parseError: string;
  /**
   * Set by a throw site that already KNOWS its class, so the response helper
   * does not have to re-derive it by sniffing prose it was just handed.
   * Omitted for the YAML gates, whose `parseError` is a real parser message
   * that `classifyParseError` reads correctly.
   */
  readonly refusalClass?: FrontmatterMalformedClass;
  /** Fix advice replacing `FIX_HINT` when the YAML-quoting hint would not apply. */
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

/**
 * Bounded-cardinality refusal class for the structured
 * `frontmatter-malformed-write-refused` log event. Adding this label lets
 * ops slice the residual refusal stream after the recursive value schema
 * landed — the `nested-rejected` bucket no longer fires because
 * nested mappings + arrays of objects validate cleanly. If the
 * `schema-rejection` count spikes after a release, the schema has
 * regressed (or a new genuinely non-representable value class slipped
 * through). `parseError` itself stays free-form on the event for diagnosis,
 * but is intentionally NOT a counter label (cardinality discipline).
 *
 * Class mapping by `parseFrontmatterYaml` parseError prefix:
 *   - `'yaml-parse-error'`        ← yaml@2 raised, or `parseDocument` /
 *                                   `toJS` threw (bytes can't be parsed)
 *   - `'non-mapping-top-level'`   ← bytes parse but top-level isn't a
 *                                   mapping (sequence, scalar, null)
 *   - `'schema-rejection'`        ← bytes parse to a mapping, but a value
 *                                   shape is outside the recursive
 *                                   FrontmatterValueSchema (e.g. function,
 *                                   Symbol leaf; `null` shapes are coerced to
 *                                   empty values, not rejected)
 *   - `'byte-0-promotion'`        ← NOT a parse outcome: the bytes never got
 *                                   as far as YAML. An append/prepend would
 *                                   have placed a `---` fence pair at offset
 *                                   0, so the composed document would read
 *                                   the agent's body as its frontmatter.
 *                                   Carried on the error by the throw site
 *                                   rather than inferred from `parseError`,
 *                                   which keeps placement refusals out of the
 *                                   `yaml-parse-error` bucket — that bucket's
 *                                   whole job is spotting a schema/parser
 *                                   regression by its count.
 *   - `'unknown'`                 ← fallback (should be unreachable; logged
 *                                   so a future parseError prefix that
 *                                   doesn't match any branch surfaces
 *                                   instead of silently collapsing)
 */
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
  // Everything else surfaces from `doc.errors[0].message` — yaml@2's
  // free-form line/column text (unquoted-colon class). Bucket as
  // yaml-parse-error since the bytes failed yaml@2's own parse pass.
  if (parseError.length > 0 && parseError !== 'unknown YAML parse error') {
    return 'yaml-parse-error';
  }
  return 'unknown';
}

/**
 * The refusal's bounded-cardinality class. A throw site that knows its own
 * class wins; only the YAML gates fall through to prose classification.
 *
 * Module-private on purpose: both refusal surfaces reach it through
 * `logFrontmatterRefusal`, which is the single emission site. Exporting it
 * would re-open the door this consolidation closed — a caller reading the
 * class itself is one step from composing its own event and drifting on the
 * label, which is exactly how placement refusals ended up counted as YAML
 * parse errors on the batch path.
 */
function frontmatterRefusalClass(err: FrontmatterMalformedError): FrontmatterMalformedClass {
  return err.refusalClass ?? classifyParseError(err.parseError);
}

/** Agent-facing detail: the diagnosis plus whichever fix advice applies. */
export function frontmatterRefusalDetail(err: FrontmatterMalformedError): string {
  return `${err.parseError}. ${err.hint ?? FIX_HINT}`;
}

/**
 * Emit the structured refusal event. Both refusal surfaces route through here
 * so the grouped-by-handler counter stays consistent across gates.
 */
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

/**
 * Translate a `FrontmatterMalformedError` into the slim RFC 9457 problem+json
 * envelope at HTTP 400. The exact wire shape is a 1-way-door contract — see
 * the file header for the literal body.
 *
 * Callers wrap their handler body in `try { ... } catch (err) { if (err
 * instanceof FrontmatterMalformedError) { respondFrontmatterMalformed(res, err, 'handler-name'); return; } throw err; }`.
 * A surface that composes something other than an HTTP response (see
 * `agent-write-batch`) calls `logFrontmatterRefusal` + `frontmatterRefusalDetail`
 * instead, so the event and the detail stay identical across both.
 */
export function respondFrontmatterMalformed(
  res: ServerResponse,
  err: FrontmatterMalformedError,
  handler: string,
): void {
  // `class` is the bounded-cardinality slice for counters / dashboards (one
  // of four enum values — see `classifyParseError`). `parseError` rides as
  // free-form text for diagnosis: bounded by the underlying parser's
  // message shapes but intentionally NOT a counter label (cardinality
  // discipline). The `nested-rejected`
  // bucket no longer fires because the recursive value schema accepts
  // nested mappings + arrays of objects — a spike in `schema-rejection` is
  // now the signal that the schema regressed or a new non-representable
  // value class surfaced.
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
