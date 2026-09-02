# `no-comments`

Open Knowledge writes **no code comments by default**. A comment is legal only when a tool
parses it, or when it carries a contract that code cannot express. Everything else belongs in
the commit message, the PR body, `AGENTS.md`, a spec, or a `README`.

This directory is the single source of truth for that rule. It is a zero-dependency plain-ESM
module so that every consumer runs the *same* predicate:

| Consumer | Lane | Why it exists |
|---|---|---|
| `oxlint` JS-plugin rule | `pnpm lint`, pre-push, CI, editor squiggles | blocking feedback where you already read diagnostics |
| backstop sweep (`scripts/no-comments-sweep.test.mjs`) | `pnpm check` | suppression-blind and oxlint-version-independent — a rule disable cannot silence it |
| comment codemod | one-shot cleanup + rebase recipe | gate and codemod agree by construction, not by transcription |
| `PreToolUse` hook | write time | denies the comment before it is ever written |

## Running the rule

`pnpm lint` runs `oxlint --max-warnings 0 .`, which loads this plugin from the `jsPlugins`
entry in `oxlint.config.ts`. Loading it is free: the whole-tree run takes the same 6.3s with the
entry as without it. Enforcing costs whatever rendering the findings costs, so the only figure
measured so far is a ceiling — on the *uncleaned* tree the run emits 158,601 diagnostics and
takes 15-20s depending on machine load. The steady state after the cleanup is the loaded-but-
quiet number, not that one.

The editor tier comes with the same install: oxc's editor extensions spawn `oxlint --lsp` from
the project's own `node_modules`, so the language server runs this repo's pinned oxlint and
loads this plugin with it. Verified by driving the server over stdio — opening an in-scope file
publishes this rule's diagnostics as `no-comments(no-comments)`, each carrying the class, the
fix, and the docs anchor, at the lines the CLI reports. Opening a fixture publishes nothing,
because the fixture corpus sits outside the declared scope on purpose.

Two limits are worth knowing before relying on this lane alone:

- JS plugins are alpha upstream and still moving.
- oxc's pure-Rust *standalone* binary accepts a config naming a `jsPlugins` entry, drops the
  plugin, and exits 0 with no warning (oxc-project/oxc#25203). Nothing here runs that binary —
  `pnpm lint` and the editor both use the npm package — but the failure mode is silent where it
  does bite.

The backstop sweep exists for exactly that class of hole: it re-runs this module over the same
scope with no linter involved, so a rule disable, an alpha regression, or a distribution that
quietly drops JS plugins cannot leave the repo unguarded.

## Running the sweep

`pnpm check` runs the sweep as `scripts/no-comments-sweep.test.mjs`, which the Vitest script
project picks up by glob. `node scripts/no-comments-sweep.mjs` runs the same pass by hand and
prints a per-stratum report — files, comment lines, violations — which is where the cleanup's
before-and-after numbers come from; `--all` lists every violation rather than the first 25.

That script lives in the monorepo's `scripts/`, which is enumerated rather than mirrored, so this
lane is upstream-only; the public tree keeps the oxlint rule.

Both lanes enforce at `error` severity over a corpus at zero violations, and a test pins them
to the same value so neither can be turned off without the other.

## The write-time hook

A `PreToolUse` hook on `Edit`/`Write` (`.claude/hooks/no-comments-guard.sh`, evaluating through
`scripts/no-comments-hook.mjs`) applies the pending edit in memory and denies it when the result
carries a comment this predicate rejects. It is diff-scoped: it compares the comments before and
after the edit and reports only what the edit adds, so an edit to a file that still holds
uncleaned stock is never blocked by comments it did not write.

`ALLOW_OK_COMMENT_EDIT=<repo-relative-path>` waves one edit through, and only for the paths it
names (comma-separate several). The bare `=1` form is retired: a wholesale valve silenced the
lane for every path at once, which is exactly when it should still be speaking. The hook fails open — no `jq`, no `node`, or no
evaluator means it exits silently — because `pnpm lint` and `pnpm check` are the blocking floors
and this lane only moves the feedback earlier. Harnesses that do not run hooks are covered by the
staged `oxlint` pass in `lint-staged`.

Like the sweep, the hook lives outside the mirrored tree, so it is upstream-only.

## Allowlist

### Tool-parsed directives

`@ts-expect-error <reason>` (a reason is required), `biome-ignore <rule>: <reason>`,
`oxlint-disable*` / `eslint-disable*`, `@vite-ignore`, `prettier-ignore`,
`/// <reference …>`, `@vitest-environment`, `@ts-nocheck`, `@__PURE__`,
`@__NO_SIDE_EFFECTS__`, `@preserve`, the JSX pragmas (`@jsx`, `@jsxFrag`, `@jsxRuntime`,
`@jsxImportSource`), webpack magic comments, `//# sourceMappingURL=` / `//# sourceURL=`,
`v8|c8|istanbul ignore`, `@ts-check`, `@lintignore <reason>` in JSDoc block form
(knip reads it because `knip.config.ts` declares `tags: ['-lintignore']`, and knip only parses
JSDoc, so a `// @lintignore` line comment is not machine-consumed and stays banned), and SPDX /
`@license` headers.

The build annotations are read by the bundlers this repo actually ships through: rolldown — the
engine under `tsdown`, which builds `core`, `server`, and `cli` — declares `@__PURE__`,
`@__NO_SIDE_EFFECTS__`, and `@vite-ignore` as one `comments.annotation` class, and that option is
the repo-side revocation knob the governability test asks for. Deleting one is the silent-green
failure this allowlist exists to prevent: bundle output changes while typecheck, lint, and tests
all stay green. The JSX pragmas are TypeScript's own per-file `commentPragmas`, and
`//# sourceMappingURL=` detaches a source map when it is dropped.

Directives must **begin** the comment, exactly as the tool that reads them requires. Prose that
merely mentions a directive (`// we should biome-ignore this later`) is prose. Shapes whose
grammar takes exactly one argument are anchored on both ends, so `// @jsx is the pragma we should
add` is prose while `/** @jsx h */` is a directive.

A comment is code when three things hold: (1) a tool THIS REPO RUNS parses it; (2) the behavior
it buys is one the repo wants and can govern — a suppression the repo's own config cannot revoke
is not governable, which is why knip's built-in `@public`/`@beta`/`@alias` are deliberately
excluded (they silence knip unconditionally and carry no reason; `@lintignore <reason>` is the
single sanctioned knip channel, revocable in `knip.config.ts`); and (3) it carries its reason
wherever the tool's grammar has room for one, as `@ts-expect-error <reason>`,
`biome-ignore <rule>: <reason>`, and `@lintignore <reason>` already do. A shape that satisfies
all three is added to `DIRECTIVE_PATTERNS` in `allowlist.mjs`, not argued about.

Three shapes that look like directives are **excluded**, each failing part (1). `/* eslint-env … */`
and `/* globals … */`: no ESLint is installed here, and oxlint 1.66 emits the identical `no-undef`
diagnostics whether or not the pragmas are present, so they buy nothing — its governable channel is
the `env` / `globals` block in `.oxlintrc`, not a comment. `// #region` / `// #endregion`: an editor
folding marker, read by no tool this repo runs, and the section-divider shape the ban exists to kill.

`@ts-ignore` is **banned** — it silently outlives the error it suppresses. Use
`@ts-expect-error <reason>`.

### Sanctioned audit tags

A JSDoc block carrying one of the repo's sanctioned audit tags survives whole. The vocabulary is
whatever `SANCTIONED_TAGS` holds in `allowlist.mjs`, pinned against its owning audit framework by a
drift test. A repo that ships no such framework has an empty list, and then this class admits
nothing — do not assume a tag-bearing JSDoc is allowed without checking `SANCTIONED_TAGS`.

### `jsdoc-type` (`.mjs` / `.cjs` / `.js` only)

A JSDoc block whose every line is a bare type annotation (`@type {…}`, `@param {…} x`,
`@returns {…}`, `@typedef`, `@template`, `@satisfies`, `@import {…} from '…'`) is admitted in
the JavaScript strata, where it is the only typing mechanism the language has. Two hard edges:
a description after the identifier makes the block prose (the `{type}` is the machine payload;
the sentence after it is exactly what the ban exists to kill), and the same block in a `.ts`
file is prose, because TypeScript has real syntax there.

### `@deprecated`

A JSDoc `@deprecated` block survives; it is read by editors and by consumers. The tag must open
its own line — the same anchoring the sanctioned audit tags get. Prose that merely names it is
prose, in all three laundering shapes `must-fire.fixture.ts` pins: appended to a sentence,
inlined in a narrating block, and backticked as the subject of a discussion.

### Contract markers

A comment may begin with one of three markers:

- `STOP: <contract>` — an in-repo cross-file contract a reader must not break.
- `WARN: <drift warning>` — a sibling that silently drifts if this changes.
- `UPSTREAM(<referent>): <constraint>` — a code shape forced from **outside** the repo.

`UPSTREAM` referents are shape-validated: `owner/repo#N`, `RFC <n>`, `CommonMark §<n>`, or
`pkg@<version>`. One shape-valid referent goes in the parentheses; supporting links (a fix PR,
a second issue) belong in the marker body, where they survive untouched. The legitimacy line: the constraint's origin must be outside the repo — we
patch a dependency, work around its bug, conform to its spec, or absorb a platform quirk.
A surprise in *our own* code never earns a comment; reshape the code instead. Restating a
dependency's own documentation dies. Our bug in third-party costume dies.

### Validated precedent citations

A comment containing `precedent #N` survives when `N` is a real slot in `PRECEDENTS.md`.
Numbers come from the `## Section (precedents A, B, C)` headings — never from list ordinals,
which drift. Retracted slots (`#12`, `#29`, `#52`) keep their numbers and stay citable.
`PRECEDENTS.md` is not part of the public mirror; validation there runs from
`precedent-numbers.generated.json`, a numbers-only manifest regenerated by
`pnpm run generate:precedent-numbers` and pinned fresh by a drift test, so a fabricated
citation is rejected on both surfaces. A tree with neither file fails loud rather than
admitting citations.

The manifest describes the tree it ships in, so it only stands in for that tree's
`PRECEDENTS.md`. Point the predicate at a different repository that has no `PRECEDENTS.md`
of its own and citations there are admitted unvalidated instead of being checked against
these numbers - a foreign `precedent #104` is not a fabrication, and Open Knowledge's
numbering has no authority over it.

### Guard-defined metacomment markers

Machine-consumed escape channels owned by a specific guard: the `documented exemption from
Precedent #30` marker, `error-log-shape-ok: <why>`, and `presence-exempt: <why>` (the
agent-presence structural guard subtracts the sites it marks from its expected count). A new
guard marker is only legal once it is registered in `GUARD_MARKERS`.

## Violation classes

Each class is the anchor the diagnostic's docs URL points at.

### prose

The comment matches no allowlist class. Delete it, and put the reasoning where it survives
review: the commit message, the PR body, `AGENTS.md`, or the spec.

### banned-directive

`@ts-ignore`. Replace with `@ts-expect-error <reason>`, which fails once the underlying error
disappears.

### unreasoned-directive

`@ts-expect-error` with nothing after it. Append the reason inline.

### invalid-precedent

A `precedent #N` citation whose number is not a slot in `PRECEDENTS.md`. Cite a real precedent
or drop the citation.

### invalid-upstream-referent

`UPSTREAM(…)` whose referent matches none of the four accepted shapes. A referent that cannot be
resolved is not a citation.

### rot-in-survivor

An allowlisted comment carrying a process-citation token — a spec decision marker, a user-story
or requirement ID, a tracker ticket, a dated audit narrative, a line-number pointer. The
allowlist admits the comment's *purpose*, not a place to park process trail.

Three of these signatures are context-sensitive, because their shapes collide with platform
vocabulary this repo genuinely uses: `M1`-`M4` name Apple Silicon parts, `AC3` is an audio codec,
and `D-BUS` is the Linux desktop bus. Each of those three carries its own term list
(`CONTEXT_TERMS` in `rot.mjs`), and a comment matching its list is exempt from that signature
alone - codec words do not excuse a decision marker, and hardware words do not excuse an
acceptance criterion. Every term is held to the same closure discipline as the signatures: a term
with no negative fixture fails the suite.

The exemption is comment-scoped, and that is a deliberate accepted looseness rather than an
oversight. A comment that names platform vocabulary *and* separately carries genuine process
metadata keeps the metadata: `// STOP: M3 chip scaling blocks the M7 milestone` is admitted whole,
because `chip` exempts the milestone signature for the entire comment. Separating the two would
mean distinguishing a cue that explains the token from one that merely shares the sentence, which
no positional rule does - the distance between `arm64 ... M1` (must be exempt) and
`D-Bus ... D12` (should fire) is four characters. The fixtures name this trade explicitly.

## Scope

The `**/*.private.*` exclusion is a mirror-correctness carve-out, not a comment-policy one:
those files are stripped from the public export, so their contents may reference private trees
the mirror cannot resolve. The infix is not an escape hatch from this policy — a `.private.`
file still ships INTERNALLY, still rots, and review holds it to the same bar; the gate skips it
only because the mirrored predicate cannot see it anyway.

`packages/**/{src,tests}/**/*.{ts,tsx}`, `scripts/**/*.mjs`, `.github/scripts/**/*.mjs`,
`docs/**/*.{ts,tsx}`, and root `*.ts`. Excluded: the audit framework's own tree, `*.private.*`,
the fidelity and lume-qa suites, fixtures, `*.d.ts`, generated locales, `knip.config.ts`, and
build output. `scope.mjs` is the one place this is written down; the gate, the sweep, the
codemod, and the hook all read it from there.

This directory ships to the public mirror, which means its own tests may not *spell* a
`*.private.*` path: the mirror's content-leak gate rejects a named reference to one in any
shipping file. `scope.test.mjs` composes those paths from parts for that reason, and a test
added here has to do the same.

## The lexer

### Why not `context.sourceCode.getAllComments()`

The oxlint rule re-lexes `sourceCode.text` with the shared zero-dep extractor instead of using
the runtime's parsed comments, so the backstop sweep — which must run with no plugin runtime at
all — and the rule agree on the comment set by construction (spike-verified equivalent 4/4;
the differential test pins the extractor against a ts-morph oracle over a committed case table).


### Position model

Every position in this family is a UTF-16 code-unit offset into the file's text; offsets are
the only position currency that crosses a module boundary. Source text is never iterated by
code point (no `[...source]` / `Array.from(source)` over source), because that silently
re-indexes astral characters. `line`/`column` are a rendering, not a position: they count LF
only, exist for human-facing CLI and hook output, and are never handed to another tool that
owns its own line map — the oxlint rule reports ranges and lets oxlint render them with its
own ECMAScript-terminator line map.

`extract.mjs` finds comments without a parser, because the sweep, the hook, and the public
mirror all need to run without a TypeScript dependency. It is a single-pass state machine over
`code`, `template`, `jsxTag`, and `jsxChildren` frames, and it resolves the two genuine
ambiguities by leaning toward comment recall:

- **`/` — regex or division?** A regex may only start where a value may not have just ended, so
  the scan checks the previous significant token. After `)`, `]`, `}`, an identifier, a number,
  a string, or a value keyword, `/` is division. Everything else opens a regex. A regex literal
  cannot span a line, so a scan that reaches a newline rewinds and treats the `/` as division —
  which keeps a trailing comment on a line of arithmetic visible.
- **`<` — JSX or comparison?** Only in `.tsx` / `.jsx`, and only in expression position. A type
  parameter list is separated out by its `,`, its `extends`, or the `(` that follows its closing
  `>`. Reading JSX as generics costs a line; reading generics as JSX would swallow the rest of
  the file, so the tie breaks toward generics.

A `.private.` differential test pins the lexer against a TypeScript-backed oracle across every
in-scope file in the repository.

## Rebasing an in-flight branch across the cleanup

The cleanup commit deletes comment lines across the whole scope at once, so a branch that forked
before it will conflict wherever its own edits sit within a few lines of a deleted comment. Edits
further away from any deleted comment merge clean and need nothing.

Two conflict shapes, two resolutions:

1. **Both sides of the hunk differ only in comments** - your branch reworded or moved a comment the
   cleanup deleted. Take main's side. No code is lost, and the result is token-identical to what
   your branch had.

2. **Your code change sits beside a deleted comment**, so the hunk carries both. Do NOT take main's
   side: it would silently drop your change. Re-run the codemod on your branch's files and commit,
   then merge again. The codemod is idempotent, so both sides now carry the same deletions and the
   remaining conflict is your own change with no comments in it - resolve it by taking your side.

```
node scripts/comment-codemod.mjs --root <your-repo> --write
```

The exit code is the machine half of that recipe, so a chained command can branch on it:

| code | meaning |
|---|---|
| 0 | clean: everything in scope was stripped, nothing was declined |
| 1 | a file's token stream diverged, so nothing was written for it - the tree is unchanged and this is a bug to report, not a rebase step |
| 2 | the invocation was refused before any work: `--file` with no path, an out-of-scope `--file`, or `--write` with no protected-region net |
| 3 | wrote successfully, and a human still has work: a rot token inside an otherwise legitimate marker was left in place for you to strip by hand |

A protected-region collision exits 0 by design. It means the comment overlaps a span the mirror
manifest pins, so declining to touch it is the correct terminal state rather than pending work -
the report still names it. Under `set -e`, note that 3 is a success in the human sense: the files
that could be written were.

Both resolutions are pinned by `scripts/comment-codemod.test.mjs`, which replays each shape through
a real `git merge` in a throwaway repository and checks the result with the token-stream oracle.

`scripts/comment-codemod.mjs` is upstream-only: `scripts/` is enumerated in the mirror manifest
rather than globbed, so the codemod does not ship to the public repository. Rule 1 needs no tooling.
