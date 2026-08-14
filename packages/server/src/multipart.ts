/**
 * The one sanctioned way to construct a `multipart/form-data` parser.
 *
 * busboy's `defParamCharset` defaults to `latin1` — an inheritance from
 * `Content-Disposition`'s original MIME/email definition, not from the
 * `multipart/form-data` rules. RFC 7578 governs this surface instead. It issues
 * no receiver mandate — §5.1.3 is explicit that a parser cannot assume any
 * particular charset was used — so the default is ours to choose, and UTF-8 is
 * the only defensible choice: §4.2 records that "the encoding used for the file
 * names is typically UTF-8", and the sender-side form-charset ladder in §5.1.2
 * terminates at UTF-8. Browsers and
 * Node/undici both put the name on the wire as raw UTF-8 bytes in the plain
 * `filename=` parameter, so the latin1 default reads every multi-byte sequence
 * back as one mojibake code point per byte — `café.png` arrives as
 * `cafÃ©.png`, irreversibly, before any sanitizer or storage layer sees it.
 *
 * The charset is deliberately NOT a parameter. Declaring it per call site
 * leaves a hole a future caller can fill with the wrong value; hardcoding it
 * here makes `latin1` unreachable. A lint rule (`require-utf8-multipart-parser`)
 * keeps `busboy(...)` from being called anywhere else.
 *
 * RFC 5987 / RFC 2231 extended parameters (`filename*`) are unaffected: they
 * carry their own charset and busboy decodes them independently of
 * `defParamCharset`, preferring them when present. RFC 7578 §4.2 forbids
 * clients from sending them here, so in practice this path is what matters.
 */

import type { IncomingMessage } from 'node:http';
import busboy from 'busboy';

/**
 * A constructed multipart parser. Call sites annotate with this instead of
 * `ReturnType<typeof busboy>` so they never need to import busboy themselves.
 */
export type MultipartParser = ReturnType<typeof createMultipartParser>;

/**
 * Construct a multipart parser for `req` that decodes header parameters as
 * UTF-8.
 *
 * Deliberately does NOT catch. busboy throws synchronously on a missing or
 * unparseable `Content-Type` boundary, and each caller classifies that
 * differently (the asset upload turns it into a typed
 * `urn:ok:error:malformed-upload`; the skill upload rejects raw). Swallowing it
 * here would flatten two distinct error contracts into one.
 *
 * `preservePath` is left at its `false` default, so `filename` arrives as a
 * bare basename. Anything that needs the client's directory component has to
 * widen this factory — and reason about path traversal while doing so — rather
 * than construct its own parser.
 */
export function createMultipartParser(req: IncomingMessage, limits: busboy.Limits): busboy.Busboy {
  return busboy({
    headers: req.headers,
    defParamCharset: 'utf8',
    limits,
  });
}
