// FIXTURE - drives `require-utf8-multipart-parser.test.ts` via shell-out to
// `pnpm exec biome check` on this path. The override's `includes[]` self-includes
// this file, so the rule DOES apply here; what keeps the 3 fires below out of a
// normal `pnpm run lint` is that `lint:biome` passes biome an explicit path list
// (`packages docs *.json *.jsonc *.ts`) that never visits `biome-plugins/`.
//
// 3 expected diagnostic fires (one per direct `busboy(...)` construction):
//   P1 the exact pre-fix shape that shipped the bug (no charset declared)
//   P2 an explicit `defParamCharset: 'latin1'` - the case an absence-match rule
//      would wave through, which is why this rule is a presence match
//   P3 an inline `defParamCharset: 'utf8'` - correct today, but it re-opens the
//      value hole the factory exists to close
//
// Negatives (0 fires): the sanctioned `createMultipartParser(...)` call, a
// `ReturnType<typeof busboy>` type annotation (the form a call site uses to
// name a parser's type without constructing one), a member call, and an
// unrelated identifier. Exact-equality (`toBe(3)`) catches false-negative regressions
// (< 3) and false-positive widenings (> 3) - the type-annotation negative in
// particular guards against a pattern change that starts matching type positions.
//
// This file deliberately contains no non-ASCII characters. The defect under
// enforcement is a charset misdecode, and a fixture whose bytes an editor may
// silently rewrite is the wrong place to encode one.

type Headers = Record<string, string>;
type Limits = Record<string, number>;
interface Req {
  headers: Headers;
}
declare function busboy(cfg: { headers: Headers; defParamCharset?: string; limits?: Limits }): {
  on: (event: string, cb: () => void) => void;
};
declare function createMultipartParser(req: Req, limits: Limits): ReturnType<typeof busboy>;
declare function notBusboy(cfg: object): unknown;
declare const parsers: { busboy: (cfg: object) => unknown };
declare const req: Req;

// === Positive cases - must fire (3 total) ===

// (P1) The shape that shipped the bug, copied from `readUploadBody`.
export const p1 = busboy({
  headers: req.headers,
  limits: { files: 1, fields: 10, fieldSize: 2048 },
});
// (P2) A declared charset that is the WRONG one. An absence-match rule
//      ("must contain `defParamCharset:`") would accept this.
export const p2 = busboy({ headers: req.headers, defParamCharset: 'latin1' });
// (P3) The right value, still at the wrong place - the next editor of this line
//      has no signal that the literal is load-bearing.
export const p3 = busboy({ headers: req.headers, defParamCharset: 'utf8' });

// === Negative cases - must NOT fire ===

// (1) The sanctioned form.
export const n1 = createMultipartParser(req, { files: 1 });
// (2) Type position, not a call expression. `api-extension.ts` carried exactly
//     this annotation at both call sites before the factory landed.
export type N2 = ReturnType<typeof busboy>;
// (3) Member call - a different AST (documented gap).
export const n3 = parsers.busboy({ headers: req.headers });
// (4) An unrelated identifier - the rule matches a literal callee name.
export const n4 = notBusboy({ headers: req.headers });
